const net = require('net')

/**
 * @typedef {object} TinyProxyOptions
 * @property {string} proxyType - 'socks', 'http'
 * @property {?number} socksType - null, 4, 5
 * @property {string} proxyAuth - basic auth
 * @property {string} proxyURL
 * @property {string} proxyHost
 * @property {string} proxyPort
 * @property {string} proxyUsername
 * @property {string} proxyPassword
 * @property {string} proxyURLWithCred
 */

class ProxyOptions {
  /**
   * @param {?string} proxyUsername
   * @param {?string} proxyPassword
   * @returns {string}
   */
  static makeAuth(proxyUsername, proxyPassword) {
    if (proxyPassword && proxyUsername) {
      const base64Credentials = Buffer.from(`${proxyUsername}:${proxyPassword}`).toString('base64')
      return `Basic ${base64Credentials}`
    }

    return ''
  }

  /**
   * @param {string} proxyURL
   * @param {?string} proxyUsername
   * @param {?string} proxyPassword
   * @returns {TinyProxyOptions|null}
   */
  static makeProxyOptions(proxyURL, proxyUsername, proxyPassword) {
    if (!proxyURL) {
      return null
    }

    const { hostname, port: proxyPort, protocol } = new URL(proxyURL)

    if (!hostname || typeof hostname !== 'string') {
      return null
    }

    const proxyHost = /^\[.*]$/.test(hostname) && net.isIPv6(hostname.slice(1, -1)) ? hostname.slice(1, -1) : hostname

    const proxyType = /^socks/.test(proxyURL) ? 'socks' : 'http'
    const socksType = proxyType === 'socks' ? (/^socks5?:/.test(proxyURL) ? 5 : 4) : null
    const proxyAuth = ProxyOptions.makeAuth(proxyUsername, proxyPassword)
    const proxyURLWithCred = [protocol, '//']

    if (proxyPassword && proxyUsername) {
      proxyURLWithCred.push(proxyUsername, ':', proxyPassword, '@')
    }

    proxyURLWithCred.push(proxyHost, ':', proxyPort)

    return {
      proxyType,
      socksType,
      proxyAuth,
      proxyURL,
      proxyHost,
      proxyPort,
      proxyUsername,
      proxyPassword,
      proxyURLWithCred: proxyURLWithCred.join('')
    }
  }
}

module.exports = ProxyOptions
