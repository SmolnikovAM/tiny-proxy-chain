const net = require('net')
const { SocksClient } = require('socks')
const BaseHandler = require('./base-handler.js')

class HttpConnector {
  /**
   * @param {object} options
   * @param options.proxyPort
   * @param {number} proxyPort
   * @param {string} proxyHost
   * @param {Function} resolve
   * @param {string} requestString
   * @param {number} connectionTimeout
   * @param {Function} log
   * @param options.proxyHost
   * @param options.resolve
   * @param options.requestString
   * @param options.connectionTimeout
   * @param options.debugLog
   * @param options.log
   */
  constructor({ proxyPort, proxyHost, resolve, requestString, connectionTimeout, debugLog, log }) {
    this.proxyHost = proxyHost
    this.proxyPort = proxyPort
    this.resolve = resolve
    this.connectionTimeout = connectionTimeout
    this.socket = null
    this.requestString = requestString
    this.onConnectBind = this.onConnect.bind(this) // for easy removing and without touching other listeners
    this.onTimeoutBind = this.onTimeout.bind(this)
    this.dataAcc = Buffer.alloc(0)
    this.onDataBind = this.onData.bind(this)
    this.onErrorBind = this.onError.bind(this)
    this.log = log
    this.debugLog = debugLog
  }

  connect() {
    this.socket = net.connect(this.proxyPort, this.proxyHost, this.onConnectBind)
    this.socket.once('timeout', this.onTimeoutBind)
    this.socket.on('data', this.onDataBind)
    this.socket.once('error', this.onErrorBind)
  }

  /**
   * @param {buffer} data
   */
  onData(data) {
    this.dataAcc = Buffer.concat([this.dataAcc, data])

    const headerIndex = this.dataAcc.indexOf(Buffer.from('\r\n\r\n'))

    if (headerIndex === -1) {
      return
    }

    if (this.connectionTimeout) {
      this.socket.setTimeout(this.connectionTimeout)
    }

    this.socket.off('data', this.onDataBind)
    this.socket.off('error', this.onErrorBind)
    this.socket.off('timeout', this.onTimeoutBind)

    const [protocol, statusCode, description] = this.dataAcc.subarray(0, headerIndex).toString().split(' ')

    if (statusCode === '200') {
      const remainingData = this.dataAcc.subarray(headerIndex + 4)

      if (remainingData.length > 0) {
        this.socket.unshift(remainingData)
      }

      this.dataAcc = null

      this.resolve({
        protocol,
        socket: this.socket,
        statusCode,
        description
      })

      this.socket = null

      return
    }

    this.dataAcc = null

    BaseHandler.closeSocket(this.socket, this.debugLog)
    this.resolve({ statusCode, description })
    this.socket = null
  }

  onConnect() {
    if (!this.socket) {
      return
    }

    this.socket.setTimeout(0)

    if (!this.socket.writable) {
      BaseHandler.closeSocket(this.socket, this.debugLog)
      return this.resolve({ statusCode: '500', error: 'Connection error' })
    }

    this.socket.write(this.requestString)
  }

  onTimeout() {
    BaseHandler.closeSocket(this.socket, this.debugLog)
    this.resolve({ statusCode: '504', error: 'Gateway Timeout' })
  }

  onError() {
    this.resolve({ statusCode: '500', error: 'Connection error' })
    this.close()
  }

  close() {
    if (this.socket) {
      BaseHandler.closeSocket(this.socket, this.debugLog)
      this.socket = null
    }
  }
}

class ConnectionHandler extends BaseHandler {
  /**
   * @param {object} options
   * @param {Function} options.log
   * @param {number} options.debug
   * @param {number} options.connectionTimeout
   * @param {TinyProxyOptions} options.defaultProxyOptions
   * @param {onRequestFunction} options.onRequest
   * @param {string|number} options.proxyId
   * @param options.req
   * @param {IncomingMessage} req
   * @param {Socket} clientSocket
   * @param {Buffer} head
   * @param options.clientSocket
   * @param options.head
   */
  constructor({
    req,
    clientSocket,
    head = Buffer.alloc(0),
    log,
    debug,
    connectionTimeout,
    defaultProxyOptions,
    onRequest,
    proxyId
  }) {
    super({ log, debug, connectionTimeout, defaultProxyOptions, onRequest, proxyId })
    this.req = req
    this.clientSocket = clientSocket
    this.serverSocket = null
    this.head = head
    this.closed = false
    this.sentErrorFlag = false
    this.HTTPConnector = null
  }

  /**
   * @returns {Promise<boolean>}
   */
  async run() {
    if (!super.run()) {
      return false
    }

    this.clientSocket.once('error', this.close.bind(this, 'client error'))
    this.clientSocket.once('close', this.close.bind(this, 'client close'))
    this.clientSocket.once('end', this.close.bind(this, 'client end'))
    this.clientSocket.once('timeout', this.close.bind(this, 'client timeout'))

    const { socket, description, statusCode, protocol } = await this.getServerSocket()

    if (this.closed) {
      this.close() // connection timeout fired and serverSocket is active
      return false
    }

    if (this.connectionTimeoutId) {
      clearTimeout(this.connectionTimeoutId)
      this.connectionTimeoutId = null
    }

    if (statusCode !== '200') {
      this.sendError(statusCode, description)
      return false
    }

    this.serverSocket = socket

    if (!this.clientSocket.writable) {
      this.close()
      return false
    }

    this.clientSocket.write(`${protocol} 200 ${description}\r\n\r\n`)

    this.serverSocket.on('error', this.send500Error.bind(this))
    this.serverSocket.once('end', this.send500Error.bind(this))

    this.clientSocket.pipe(this.serverSocket)
    this.serverSocket.pipe(this.clientSocket)

    this.serverSocket.on('data', this.onUpload.bind(this))
    this.clientSocket.on('data', this.onDownload.bind(this))

    if (this.head && this.head.length > 0) {
      this.serverSocket.write(this.head)
      this.head = null
    }

    return true
  }

  /**
   * @returns {Promise}
   */
  async getServerSocket() {
    if (this.proxyOptions.proxyType === 'socks') {
      try {
        return await this.connectToSocksProxy()
      } catch (e) {
        this.log(e)
        return null
      }
    }

    if (this.proxyOptions.proxyType === 'http' || this.proxyOptions.proxyType === 'https') {
      return new Promise(this.resolvePromise.bind(this))
    }

    return null
  }

  /**
   * @param {Function} resolve
   */
  resolvePromise(resolve) {
    try {
      this.connectToHttpProxy(resolve)
    } catch (e) {
      this.log(e)
      resolve({ code: '500', error: 'Connection error' })
    }
  }

  /**
   * @returns {string}
   */
  getHttpRequestString() {
    const headers = [
      `${this.req.method} ${this.req.url} HTTP/${this.req.httpVersion}`,
      ...Object.entries(this.req.headers).map(([header, value]) => `${header}: ${value}`)
    ]

    if (this.proxyOptions.proxyAuth) {
      headers.push(`Proxy-Authorization: ${this.proxyOptions.proxyAuth}`)
    }

    return headers.join('\r\n').concat('\r\n\r\n')
  }

  /**
   * @param {Function} resolve
   */
  connectToHttpProxy(resolve) {
    const { proxyPort, proxyHost } = this.proxyOptions

    this.HTTPConnector = new HttpConnector({
      proxyHost,
      proxyPort,
      resolve,
      requestString: this.getHttpRequestString(),
      log: this.log,
      debugLog: this.debugLog.bind(this)
    })

    this.HTTPConnector.connect()
  }

  /**
   * @returns {Promise<{object}>}
   */
  async connectToSocksProxy() {
    const [host, port] = this.req.url.split(':')

    const options = {
      proxy: {
        host: this.proxyOptions.proxyHost,
        port: parseInt(this.proxyOptions.proxyPort),
        type: this.proxyOptions.socksType, // 4 or 5
        userId: this.proxyOptions.proxyUsername,
        password: this.proxyOptions.proxyPassword
      },

      command: 'connect',

      destination: {
        host,
        port: parseInt(port) || 80
      }
    }

    try {
      const { socket } = await SocksClient.createConnection(options)

      return {
        protocol: 'HTTP/1.1',
        socket,
        statusCode: '200',
        description: 'Connection established'
      }
    } catch (e) {
      return { code: '500', error: 'Connection error' }
    }
  }

  /**
   * @param {string} code
   * @param {string} error
   */
  sendError(code, error) {
    if (!this.sentErrorFlag && this.clientSocket && this.clientSocket.writable) {
      this.sentErrorFlag = true
      this.clientSocket.write(`HTTP/${this.req.httpVersion} ${code} ${error}\r\n\r\n`)
    }

    this.close()
  }

  /**
   * @param {string} [reason]
   * @param {string|Error} [err]
   */
  close(reason = '', err = '') {
    this.debugLog('close Connection', reason, err)
    super.close()

    if (this.clientSocket) {
      BaseHandler.closeSocket(this.clientSocket, this.debugLog.bind(this))
      this.clientSocket = null
    }

    if (this.serverSocket) {
      BaseHandler.closeSocket(this.serverSocket, this.debugLog.bind(this))
      this.serverSocket = null
    }

    if (this.HTTPConnector) {
      this.HTTPConnector.close()
    }
  }
}

module.exports = ConnectionHandler
