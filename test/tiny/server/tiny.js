const http = require('http')
const TinyProxyChain = require('../src/tiny-proxy-chain.js')

const { PING_PORT, TINY_HTTP_PORT, HTTP_PROXY, TINY_SOCKS_PORT, SOCKS_PROXY } = process.env

const ready = [null, null].map(() => {
  let resolver
  const promise = new Promise((resolve) => (resolver = resolve))

  setTimeout(resolver, 5000) // timeout for previous version. TODO: remove this line after merge request

  return { promise, resolver }
})

let uploadAcc = 0
let downloadAcc = 0

let deltaPong = 0

Promise.all(ready.map(({ promise }) => promise)).then(() => {
  http
    .createServer((req, res) => {
      res.statusCode = 200

      switch (req.url) {
        case '/ping':
          if (deltaPong < Date.now()) {
            deltaPong = Date.now() + 30 * 1000
            console.log('-> pong')
          }
          break
        case '/clean-stat':
          console.log('-> clean stat')
          uploadAcc = 0
          downloadAcc = 0
          break
        case '/get-stat':
          console.log('-> return stat')
          res.setHeader('Content-Type', 'application/json')
          res.write(JSON.stringify({ uploadAcc, downloadAcc }))
          break
      }
      res.end()
    })
    .listen(parseInt(PING_PORT), () => console.log('Ping-pong started'))
})

function onTraffic(data) {
  downloadAcc += data.downloadBytes
  uploadAcc += data.uploadBytes
}

new TinyProxyChain({
  listenPort: parseInt(TINY_HTTP_PORT),
  proxyURL: HTTP_PROXY,
  statistics: true,
  debug: 2
})
  .listen(() => {
    ready[0].resolver()
    console.log(`Tiny start listening: on port listenPort ${TINY_HTTP_PORT} for proxy ${HTTP_PROXY}`)
  })
  .on('traffic', onTraffic)

new TinyProxyChain({
  listenPort: parseInt(TINY_SOCKS_PORT),
  proxyURL: SOCKS_PROXY,
  statistics: true,
  debug: 2
})
  .listen(() => {
    ready[1].resolver()
    console.log(`Tiny start listening: on port listenPort ${TINY_SOCKS_PORT} for proxy ${SOCKS_PROXY}`)
  })
  .on('traffic', onTraffic)
