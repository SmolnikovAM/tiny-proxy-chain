const http = require('http')
const https = require('https')
const { EventEmitter } = require('events')

const RequestHandler = require('./request-handler')
const ConnectionHandler = require('./connection-handler')
const ProxyOptions = require('./proxy-options')

/**
 * @callback onRequestFunction
 * @param {IncomingMessage} httpRequest
 * @param {TinyProxyOptions} proxyOptions
 * @returns {TinyProxyOptions|null}
 */

class TinyProxyChain extends EventEmitter {
  /**
   * @param {object} params
   * @param {number} params.listenPort
   * @param {string} [params.proxyURL] - 'socks://127.0.0.1:8081'
   * @param {string} [params.proxyUsername]
   * @param {string} [params.proxyPassword]
   * @param {number} [params.debug]
   * @param {onRequestFunction} [params.onRequest]
   * @param {string} [params.key] - ssl key
   * @param {string} [params.cert] - ssl cert
   * @param {string} [params.ca] - ssl cert
   * @param {?number} [params.connectionTimeout] - close inactive socket
   * @param {Function} [params.log]
   * @param {boolean} [params.statistics]
   */
  constructor({
    listenPort,
    proxyURL,
    proxyUsername,
    proxyPassword,
    debug = 0,
    onRequest = (_, opts) => opts,
    key = '',
    cert = '',
    ca = '',
    connectionTimeout = 60 * 1000,
    log = console.log,
    statistics = false
  }) {
    super()
    this.log = typeof log === 'function' ? log : console.log
    this.statistics = statistics

    // todo: alternative get init data from env
    this.listenPort = listenPort
    this.proxyURL = proxyURL
    this.proxyUsername = proxyUsername
    this.proxyPassword = proxyPassword
    this.defaultProxyOptions = ProxyOptions.makeProxyOptions(this.proxyURL, this.proxyUsername, this.proxyPassword)

    this.key = key
    this.ca = ca
    this.cert = cert

    this.httpsServerOptions = key && cert && ca && key.length && cert.length && ca.length ? { key, cert, ca } : null

    this.proxyIsHttps = Boolean(this.httpsServerOptions)

    this.debug = debug
    this.onRequest = onRequest
    this.connectionTimeout = connectionTimeout || 0

    this.onHttpRequestBind = this.onHttpRequest.bind(this)
    this.onConnectRequestBind = this.onConnectRequest.bind(this)

    this.connections = new Map()

    this.proxy = null

    this.proxy = this.proxyIsHttps
      ? https.createServer(this.httpsServerOptions, this.onHttpRequestBind)
      : http.createServer(this.onHttpRequestBind)

    this.proxy.on('connect', this.onConnectRequestBind)
  }

  warnLog(...args) {
    // todo process.env.production replace
    if (this.debug >= 1) {
      this.log('[WARN]', ...args)
    }
  }

  debugLog(...args) {
    if (this.debug >= 2) {
      this.log('[DEBUG]', ...args)
    }
  }

  /**
   * @param {?string} proxyUsername
   * @param {?string} proxyPassword
   * @returns {string}
   */
  static makeAuth(proxyUsername, proxyPassword) {
    return ProxyOptions.makeAuth(proxyUsername, proxyPassword)
  }

  /**
   * @param {?string} proxyURL
   * @param {?string} proxyUsername
   * @param {?string} proxyPassword
   * @returns {TinyProxyOptions|null}
   */
  static makeProxyOptions(proxyURL, proxyUsername, proxyPassword) {
    return ProxyOptions.makeProxyOptions(proxyURL, proxyUsername, proxyPassword)
  }

  /**
   * @param {IncomingMessage} req
   * @param {Socket} clientSocket
   * @param {Buffer} head
   */
  makeConnection(req, clientSocket, head) {
    return this.onConnectRequest(req, clientSocket, head)
  }

  /**
   * @param {IncomingMessage} req
   * @param {Socket} clientSocket
   * @param {Buffer} head
   */
  onConnectRequest(req, clientSocket, head) {
    this.debugLog('-> CONNECT req')
    const connectionHandler = new ConnectionHandler({
      req,
      clientSocket,
      head,
      log: this.log,
      debug: this.debug,
      connectionTimeout: this.connectionTimeout,
      defaultProxyOptions: this.defaultProxyOptions,
      onRequest: this.onRequest,
      proxyId: this.proxyId
    })

    if (this.statistics) {
      connectionHandler
        .on('download', this.onDownload.bind(this))
        .on('upload', this.onUpload.bind(this))
        .once('close', connectionHandler.removeStatListeners.bind(connectionHandler))
    }

    connectionHandler.run().catch(this.log)
  }

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  makeRequest(req, res) {
    return this.onHttpRequest(req, res)
  }

  /**
   * @param {IncomingMessage} req
   * @return {boolean}
   */
  checkHTTPRequest(req) {
    try {
      const { protocol } = new URL(req.url)

      if (/^https/.test(protocol || '')) {
        this.debugLog('[ERROR]', 'https through http-proxy')
        return false
      }
    } catch (e) {
      this.debugLog('[ERROR]', 'not valid url', e)
      return false
    }

    return true
  }

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  onHttpRequest(req, res) {
    this.debugLog(`-> HTTP req`, req.url)

    if (!this.checkHTTPRequest(req)) {
      res.statusCode = 400
      res.end()
      return
    }

    const requestHandler = new RequestHandler({
      req,
      res,
      defaultProxyOptions: this.defaultProxyOptions,
      onRequest: this.onRequest,
      log: this.log,
      debug: this.debug,
      connectionTimeout: this.connectionTimeout,
      statistics: this.statistics,
      proxyId: this.proxyId
    })

    if (this.statistics) {
      requestHandler
        .on('download', this.onDownload.bind(this))
        .on('upload', this.onUpload.bind(this))
        .once('close', requestHandler.removeStatListeners.bind(requestHandler))
    }

    try {
      requestHandler.run() /// .catch(e => this.log(e))
    } catch (e) {
      this.log(e)
    }
  }

  /**
   * @param {object} options
   * @param {number} options.bytes
   */
  onDownload({ bytes, ...opts }) {
    this.emit('traffic', /** @type {*} */ { ...opts, downloadBytes: bytes, uploadBytes: 0 })
  }

  /**
   * @param {object} options
   * @param {number} options.bytes
   */
  onUpload({ bytes, ...opts }) {
    this.emit('traffic', /** @type {*} */ { ...opts, downloadBytes: 0, uploadBytes: bytes })
  }

  /**
   * @param {Function} [cb]
   * @returns {TinyProxyChain}
   */
  listen(cb) {
    if (!this.proxy || !this.proxy.listening) {
      const args = /** @type {(number|function)[]} */ [this.listenPort]
      if (typeof cb === 'function') {
        args.push(cb)
      }
      this.proxy.listen(...args)
    }

    return this
  }

  /**
   * @returns {TinyProxyChain}
   */
  close() {
    if (this.proxy.listening) {
      this.proxy.removeAllListeners()
      this.proxy.close()
      this.proxy = null
    }

    return this
  }
}

module.exports = TinyProxyChain
