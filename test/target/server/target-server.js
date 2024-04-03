const http = require('http')
const https = require('https')
const fs = require('fs')
const crypto = require('crypto')

const HTTP_PORT = process.env.TARGET_HTTP_PORT || 80
const HTTPS_PORT = process.env.TARGET_HTTPS_PORT || 443

const httpsOptions = {
  key: fs.readFileSync('./key.pem'),
  cert: fs.readFileSync('./cert.pem'),
  passphrase: 'test'
}

/**
 *
 * @param req
 * @param res
 */
function echo(req, res) {
  let requestBody = ''

  req.on('data', (chunk) => {
    requestBody += chunk
  })

  req.on('end', () => {
    res.statusCode = 200
    const responseBody = {
      body: requestBody,
      headers: req.headers,
      remoteAddress: req.socket.remoteAddress.replace('::ffff:', '')
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(responseBody))
  })
}

/**
 *
 * @param {string} type
 * @param req
 * @param res
 */
function listener(type, req, res) {
  req.on('error', (e) => {
    console.log('error', e)
    res.end()
  })

  if (req.headers.type === 'echo') {
    console.log('echo')
    echo(req, res)
    return
  }

  if (req.headers.type?.includes?.('delay')) {
    console.log('echo delay')
    const [, delayRaw] = req.headers.type.split('-')
    setTimeout(() => echo(req, res), parseInt(delayRaw))
    return
  }

  if (req.headers.type?.includes?.('data')) {
    res.statusCode = 200
    const [, dataLength] = req.headers.type.split('-')
    const length = parseInt(dataLength)
    const dataReturn = Array.from({ length })
      .map(() => (Math.random() * 10) | 0)
      .join('')
    console.log(`target -> return ${dataReturn.length}`)
    res.end(dataReturn)
    return
  }

  if (req.headers.type === 'fall') {
    try {
      res.socket.on('error', console.error)
      res.socket.end()
      res.socket.destroy()
    } catch (e) {
      console.error(e)
    }
    return
  }

  res.statusCode = 200
  res.end(`{ "response": "empty" }`)
}

/**
 *
 * @param type
 * @param port
 */
function startCallback(type, port) {
  console.log(`${type} Server running on port ${port}`)
}

https
  .createServer(httpsOptions, listener.bind(null, 'https'))
  .listen(HTTPS_PORT, startCallback.bind(null, 'HTTPS', HTTPS_PORT))
  .on('error', console.error)

http
  .createServer(listener.bind(null, 'http'))
  .listen(HTTP_PORT, startCallback.bind(null, 'HTTP', HTTP_PORT))
  .on('error', console.error)
