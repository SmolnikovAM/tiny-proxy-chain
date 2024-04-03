const { EventEmitter } = require('events')

class BaseHandler extends EventEmitter {
  /**
   * @param {object} options
   * @param {Function} options.log
   * @param {number} options.debug
   * @param {number} options.connectionTimeout
   * @param {TinyProxyOptions} options.defaultProxyOptions
   * @param {onRequestFunction} options.onRequest
   * @param {string|number} options.proxyId
   */
  constructor({ log, debug, connectionTimeout, defaultProxyOptions, onRequest, proxyId, statistics }) {
    super()
    this.log = log
    this.debug = debug
    this.connectionTimeout = connectionTimeout
    this.defaultProxyOptions = defaultProxyOptions
    this.proxyOptions = null
    this.onRequest = onRequest
    this.closed = false
    this.sentErrorFlag = false
    this.proxyId = proxyId
    this.connectionTimeoutId = null
    this.statistics = statistics
  }

  debugLog(...args) {
    if (this.debug >= 2) {
      this.log('[DEBUG]', ...args)
    }
  }
  warnLog(...args) {
    // todo process.env.production replace
    if (this.debug >= 1) {
      this.log('[WARN]', ...args)
    }
  }

  static closeSocket(socket, log) {
    if (!socket) {
      return
    }

    try {
      socket.end()
    } catch (e) {
      if (typeof log === 'function') {
        log(e)
      }
    }

    try {
      socket.removeAllListeners('timeout')
      socket.removeAllListeners('error')
      socket.removeAllListeners('data')
      socket.removeAllListeners('close')
    } catch (e) {
      if (typeof log === 'function') {
        log(e)
      }
    }
    try {
      socket.destroy()
    } catch (e) {
      if (typeof log === 'function') {
        log(e)
      }
    }
  }

  static closeRequestResponse(re, log) {
    try {
      if (re && typeof re.end === 'function') {
        re.end()
      }
      if (re.socket) {
        re.socket.destroy()
      }
    } catch (e) {
      if (typeof log === 'function') {
        log(e)
      }
    }

    try {
      re.removeAllListeners('timeout')
      re.removeAllListeners('data')
    } catch (e) {
      if (typeof log === 'function') {
        log(e)
      }
    }
  }

  /**
   * @param {{length:number}} inputData
   */
  onDownload({ length = 0 } = {}) {
    const data = /** @type{*} */ this.proxyId ? { proxyId: this.proxyId, bytes: length } : { bytes: length }

    this.emit('download', data)
  }

  /**
   * @param {{length:number}} inputData
   */
  onUpload({ length = 0 } = {}) {
    const data = /** @type {*} */ this.proxyId ? { proxyId: this.proxyId, bytes: length } : { bytes: length }

    this.emit('upload', data)
  }

  removeStatListeners() {
    this.removeAllListeners('upload')
    this.removeAllListeners('download')
  }

  /**
   * @returns {boolean|Promise<boolean>}
   */
  run() {
    this.proxyOptions = this.onRequest(this.req, this.defaultProxyOptions)

    if (!this.proxyOptions) {
      this.send500Error()

      return false
    }

    if (this.proxyOptions.proxyId) {
      this.proxyId = this.proxyOptions.proxyId
    }

    if (this.connectionTimeout) {
      this.connectionTimeoutId = setTimeout(this.onConnectionTimeout.bind(this), this.connectionTimeout)
    }

    return true

    /* override */
  }

  onConnectionTimeout() {
    this.sendTimeoutError()
  }

  send500Error() {
    return this.sendError('500', 'Connection error')
  }

  sendTimeoutError() {
    return this.sendError('520', 'Gateway Timeout')
  }

  sendError() {
    /* override */
    // this.close()
  }

  close() {
    if (!this.closed) {
      this.closed = true
      this.emit('close')
    }
  }
}

module.exports = BaseHandler
