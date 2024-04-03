const http = require('http')
const { SocksProxyAgent } = require('socks-proxy-agent')
const BaseHandler = require('./base-handler.js')

class RequestHandler extends BaseHandler {
  /**
   * @param {object} options
   * @param {Function} options.log
   * @param {number} options.debug
   * @param {number} options.connectionTimeout
   * @param {TinyProxyOptions} options.defaultProxyOptions
   * @param {onRequestFunction} options.onRequest
   * @param {string|number} options.proxyId
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {boolean} statistics
   */
  constructor({ req, res, log, debug, connectionTimeout, defaultProxyOptions, onRequest, proxyId, statistics }) {
    super({ log, debug, connectionTimeout, defaultProxyOptions, onRequest, proxyId, statistics })
    this.req = req
    this.res = res

    // tech fields
    this.proxyReq = null
    this.proxyRes = null
    this.proxySocket = null
  }

  /**
   * @returns {object} HTTPRequestOptions
   */
  getHttpProxyRequestOptions() {
    const headers = { ...this.req.headers }

    delete headers['Proxy-Authorization']
    delete headers['proxy-authorization']

    if (this.proxyOptions.proxyAuth) {
      headers['Proxy-Authorization'] = this.proxyOptions.proxyAuth
    }

    return {
      hostname: this.proxyOptions.proxyHost,
      port: this.proxyOptions.proxyPort,
      path: this.req.url,
      method: this.req.method,
      timeout: this.connectionTimeout,
      headers
    }
  }

  /**
   * @returns {object} HTTPRequestOptions
   */
  getSocksProxyRequestOptions() {
    const { hostname, port, pathname } = new URL(this.req.url)
    const headers = { ...this.req.headers }

    delete headers['Proxy-Authorization']
    delete headers['proxy-authorization']

    return {
      hostname,
      port,
      path: pathname,
      method: this.req.method,
      headers,
      agent: new SocksProxyAgent(this.proxyOptions.proxyURLWithCred, {
        timeout: this.connectionTimeout
      })
    }
  }

  /**
   * @returns {object} HTTPRequestOptions
   */
  getRequestOptions() {
    return this.proxyOptions.proxyType === 'socks'
      ? this.getSocksProxyRequestOptions()
      : this.getHttpProxyRequestOptions()
  }

  /**
   * @returns {boolean}
   */
  run() {
    if (!super.run()) {
      return false
    }

    this.proxyReq = http.request(this.getRequestOptions())

    if (this.statistics) {
      try {
        let length = 0
        length += this.req.method.length
        length += 1
        length += this.req.url.length
        length += 1
        length += 5 + this.req.httpVersion.length
        length += 2
        length += 2 * this.req.rawHeaders.length // \r \n, ':',' ' for key value
        length += this.req.rawHeaders.reduce((a, v) => a + v.length, 0)
        length += 2

        this.onUpload({ length })
      } catch (e) {
        this.log('[ERROR] counting stat')
        this.debugLog('[ERROR]', e)
      }
    }

    this.proxyReq.once('socket', this.onProxySocket.bind(this))
    this.req.once('error', this.onError.bind(this))
    this.req.socket.once('close', this.onError.bind(this))
    this.req.socket.once('error', this.onError.bind(this))
    this.res.once('error', this.onError.bind(this))
    this.res.socket.once('close', this.close.bind(this))
    this.proxyReq.once('error', this.onError.bind(this))
    this.proxyReq.once('timeout', this.onError.bind(this))
    this.proxyReq.once('response', this.onProxyResponse.bind(this))

    this.req.pipe(this.proxyReq)
    if (this.statistics) {
      this.req.on('data', this.onUpload.bind(this)) // todo maybe socket
    }

    return true
  }

  onProxySocket(socket) {
    this.proxySocket = socket
    this.proxySocket.once('error', this.onError.bind(this))
    this.proxySocket.once('timeout', this.onError.bind(this))
    this.proxySocket.on('data', this.onDownload.bind(this)) //  data from
  }

  onProxyResponse(proxyRes) {
    this.proxyRes = proxyRes
    this.res.statusCode = this.proxyRes.statusCode

    for (let i = 0; i < this.proxyRes.rawHeaders.length; i += 2) {
      this.res.setHeader(this.proxyRes.rawHeaders[i], this.proxyRes.rawHeaders[i + 1])
    }

    this.proxyRes.pipe(this.res)
    this.proxyRes.on('error', this.onError.bind(this))
  }

  onError(e) {
    this.debugLog(e)
    this.send500Error()
  }

  send500Error() {
    this.sendError(500)
  }

  sendError(code) {
    if (!this.sentErrorFlag) {
      this.sentErrorFlag = true
      this.res.statusCode = parseInt(code)
    }

    this.close()
  }

  close() {
    this.debugLog('close HttpReq')
    if (this.res) {
      BaseHandler.closeRequestResponse(this.res, this.debugLog.bind(this))
      this.res = null
    }

    if (this.req) {
      BaseHandler.closeRequestResponse(this.req, this.debugLog.bind(this))
      this.req = null
    }

    if (this.proxyReq) {
      BaseHandler.closeRequestResponse(this.proxyReq, this.debugLog.bind(this))
      this.proxyReq = null
    }

    if (this.proxyRes) {
      BaseHandler.closeRequestResponse(this.proxyRes, this.debugLog.bind(this))
      this.proxyRes = null
    }

    if (this.proxySocket) {
      BaseHandler.closeSocket(this.proxySocket, this.debugLog.bind(this))
      this.proxySocket = null
    }

    super.close()
  }
}

module.exports = RequestHandler
