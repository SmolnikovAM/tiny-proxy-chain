# Tiny Proxy Chain

Tiny Proxy Chain is a lightweight tool for Node.js that helps set up a chain of proxies for HTTP and HTTPS traffic. It's designed to be easy and straightforward.

### Install

```shell
npm i -D tiny-proxy-chain
```

### Example of usage

```javascript
const TinyProxyChain = require('tiny-proxy-chain')

new TinyProxyChain({
  listenPort: 8080,
  proxyURL: 'http://other-proxy-host:port',
  proxyUsername: 'other-proxy-user',
  proxyPassword: 'other-proxy-password',
  debug: false,
  key: fs.readFileSync('./keys/privkey.pem'),
  cert: fs.readFileSync('./keys/cert.pem'),
  ca: fs.readFileSync('./keys/chain.pem'),
  connectionTimeout: 60000,
  onRequest: (req, defaultProxyOptions) => {
    console.log(`${req.method} ${req.url} HTTP/${req.httpVersion}`)

    if (req.headers['proxy-authorization'] !== TinyProxyChain.makeAuth('tiny-proxy-username', 'tiny-proxy-password')) {
      req.socket.write(
        `HTTP/${req.httpVersion} 407 Proxy Authentication Required\r\n` +
        `Proxy-Authenticate: Basic\r\n\r\n`
      )
    } else {
      delete req.headers['proxy-authorization']
      return defaultProxyOptions
    }
  }
}).listen()
```

### Test

To test Tiny Proxy Chain, you'll need Docker installed on your machine.

```js
npm test
```
