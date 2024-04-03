const fs = require('fs')
const path = require('path')
const yaml = require('yaml')
const tls = require('tls')
const http = require('http')
const net = require('net')
const fetch = require('node-fetch')
const { HttpsProxyAgent } = require('https-proxy-agent')
const { HttpProxyAgent } = require('http-proxy-agent')
const { upAll, down, v2: compose } = require('docker-compose')
const { AbortController } = require('abort-controller')

const DOCKER_DIR = __dirname
const DOCKER_FILENAME = 'docker-compose.yml'
const DOCKER_COMPOSE_PATH = path.resolve(DOCKER_DIR, DOCKER_FILENAME)
const options = yaml.parse(fs.readFileSync(DOCKER_COMPOSE_PATH).toString())

const composeOpts = {
  cwd: DOCKER_DIR,
  config: DOCKER_FILENAME,
  log: true
}

const DEBUG_TESTS = false

const PROXY_IP = options.services.proxy.networks.mynetwork.ipv4_address
const TARGET_IP = options.services.target.networks.mynetwork.ipv4_address
const TINY_IP = options.services.tiny.networks.mynetwork.ipv4_address

const HTTP_TARGET_URL = `http://${TARGET_IP}:80`
const HTTPS_TARGET_URL = `https://${TARGET_IP}:443`

const HTTP_TINY_PORT = 1000
const SOCKS_TINY_PORT = 1001
const HTTP_TINY_PROXY_HTTP_URL = `http://localhost:${HTTP_TINY_PORT}`
// const HTTP_PROXY_HTTP_URL = `http://localhost:8080` // for debug
const HTTP_TINY_PROXY_SOCKS_URL = `http://localhost:${SOCKS_TINY_PORT}`
// const HTTP_PROXY_SOCKS_URL = `http://localhost:1080` // for debug

const HTTP_PING_TARGET = `http://localhost:${3001}`

const IP_REGEXP = /^(\d+\.){3}\d+$/

const httpAgentToHttp = new HttpProxyAgent(HTTP_TINY_PROXY_HTTP_URL)
// const httpAgentOriginToHttp = new HttpProxyAgent(HTTP_PROXY_HTTP_URL) // for debug

const httpsAgentToHttp = new HttpsProxyAgent(HTTP_TINY_PROXY_HTTP_URL)
// const httpsAgentOriginToHttp = new HttpsProxyAgent(HTTP_PROXY_HTTP_URL) // for debug

const httpAgentToSocks = new HttpProxyAgent(HTTP_TINY_PROXY_HTTP_URL)
const httpsAgentToSocks = new HttpsProxyAgent(HTTP_TINY_PROXY_SOCKS_URL)

const originTlsConnect = tls.connect

const delay = (value) => new Promise((resolve) => setTimeout(resolve, value))
const cleanStat = () => fetch(`${HTTP_PING_TARGET}/clean-stat`, { method: 'POST' }).then((r) => r.text())
const getStat = () => fetch(`${HTTP_PING_TARGET}/get-stat`).then((r) => r.json())

tls.connect = function (...args) {
  // problem with HttpsProxyAgent and node-fetch, they cannot provide rejectUnauthorized = false to tls.connect
  // and jest cannot provide process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' into tests
  if (args[0] && typeof args[0] === 'object') {
    args[0].rejectUnauthorized = false
  } else if (args[0] && typeof args[1] === 'object') {
    args[1].rejectUnauthorized = false
  }

  return originTlsConnect.apply(this, args)
}

let SOCKET_COUNTER = 4 // fallback value

async function getSocketCount(target = 'tiny') {
  // todo: get exactly tiny.js process
  const { exitCode, out, err } = await compose.exec(target, 'ls -l /proc/1/fd', { cwd: DOCKER_DIR })
  // ls -l /proc/1/fd | grep socket | wc -l

  if (exitCode !== 0) {
    throw new Error(`error ${err}`)
  }

  const length = out.split('\n').filter((line) => line.includes('socket')).length

  return length
}

async function getContainerStats(imageName) {
  const data = await compose.ps({ cwd: DOCKER_DIR })

  const containerName = data.data.services.find((v) => v.name.includes(imageName)).name

  const socketPath = '/var/run/docker.sock'
  const url = `http://localhost/containers/${containerName}/stats?stream=false`

  const options = {
    socketPath,
    path: url,
    headers: { 'Content-Type': 'application/json' }
  }

  const stats = await new Promise((resolve, reject) =>
    http
      .request(options, (res) => {
        let acc = ''
        res
          .setEncoding('utf8')
          .on('data', (data) => (acc += data.toString()))
          .on('end', () => resolve(JSON.parse(acc)))
          .on('error', reject)
      })
      .end()
  )

  const statNetwork = Object.keys(stats.networks).reduce(
    (acc, network) => {
      ;(acc.rxBytes += stats.networks[network].rx_bytes), (acc.txBytes += stats.networks[network].tx_bytes)
      return acc
    },
    { rxBytes: 0, txBytes: 0 }
  )

  return statNetwork
}

describe('e2e tests', () => {
  beforeAll(
    async () => {
      try {
        await upAll(composeOpts)

        let i = 5
        while (i--) {
          try {
            const res = await fetch(`http://localhost:${3001}`)

            await res.text()
            if (res.status === 200) {
              break
            }
          } catch (e) {
            if (DEBUG_TESTS) {
              console.log(e)
            }
          }
          await delay(1000)
        }

        await delay(1000)
        SOCKET_COUNTER = await getSocketCount()
        if (DEBUG_TESTS) {
          console.log(`Set min socket counter ${SOCKET_COUNTER}`) // for debug
        }
      } catch (e) {
        console.error('Error starting Docker Compose services:', e)
      }
    },
    15 * 60 * 1000
  )

  afterAll(async () => {
    tls.connect = originTlsConnect
    try {
      await down(composeOpts)
    } catch (e) {
      console.error('Error stopping Docker Compose services:', e)
    }
  }, 60 * 1000)

  test('docker ip config', () => {
    expect(IP_REGEXP.test(PROXY_IP)).toBeTruthy()
    expect(IP_REGEXP.test(TARGET_IP)).toBeTruthy()
    expect(IP_REGEXP.test(TINY_IP)).toBeTruthy()

    expect(PROXY_IP === TARGET_IP).toBeFalsy()
    expect(PROXY_IP === TINY_IP).toBeFalsy()
    expect(TINY_IP === TARGET_IP).toBeFalsy()
  })

  test('HTTP-req -> httpAgent -> tiny -> HTTP-proxy', async () => {
    const body = `test body ${Math.random()}`
    const req = await fetch(HTTP_TARGET_URL, {
      method: 'POST',
      body,
      agent: httpAgentToHttp,
      headers: { type: 'echo' }
    })

    const responseData = await req.json()

    expect(req.status).toBe(200)
    expect(responseData.body).toBe(body)
    expect(responseData.remoteAddress).toBe(PROXY_IP)
  })

  test('HTTP-req -> HTTPS-agent -> tiny -> HTTP-proxy', async () => {
    const body = `test body ${Math.random()}`
    const req = await fetch(HTTP_TARGET_URL, {
      method: 'POST',
      body,
      agent: httpsAgentToHttp,
      headers: { type: 'echo' }
    })

    const responseData = await req.json()

    expect(req.status).toBe(200)
    expect(responseData.body).toBe(body)
    expect(responseData.remoteAddress).toBe(PROXY_IP)
  })

  test('HTTPS-req -> HTTP-agent -> tiny -> HTTP-proxy -> fail', async () => {
    const body = `test body ${Math.random()}`
    const req = await fetch(HTTPS_TARGET_URL, {
      method: 'POST',
      body,
      agent: httpAgentToHttp,
      headers: { type: 'echo' }
    })

    expect(req.status).not.toBe(200)
  })

  test('HTTP-req -> HTTP-agent -> tiny -> SOCKS-proxy', async () => {
    const body = `test body ${Math.random()}`
    const req = await fetch(HTTP_TARGET_URL, {
      method: 'POST',
      body,
      agent: httpAgentToSocks,
      headers: { type: 'echo' }
    })

    const responseData = await req.json()

    expect(req.status).toBe(200)
    expect(responseData.body).toBe(body)
    expect(responseData.remoteAddress).toBe(PROXY_IP)
  })

  test('HTTPS-req -> HTTP-agent -> tiny -> SOCKS-proxy -> fail', async () => {
    const body = `test body ${Math.random()}`

    const req = await fetch(HTTPS_TARGET_URL, {
      method: 'POST',
      body,
      agent: httpAgentToSocks,
      headers: { type: 'echo' },
      rejectUnauthorized: false
    })
    expect(req.status).not.toBe(200)
  })

  test('HTTPS-req -> HTTPS-agent -> tiny -> SOCKS-proxy echo', async () => {
    const body = `test body ${Math.random()}`

    const req = await fetch(HTTPS_TARGET_URL, {
      method: 'POST',
      body,
      agent: httpsAgentToSocks,
      headers: { type: 'echo' },
      rejectUnauthorized: false
    })

    const responseData = await req.json()

    expect(req.status).toBe(200)
    expect(responseData.body).toBe(body)
    expect(responseData.remoteAddress).toBe(PROXY_IP)
  })

  test('100 HTTP-req -> HTTP-agent -> tiny -> SOCKS-proxy -> target echo', async () => {
    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)
    let cnt = 0
    const TARGET_CNT = 100
    const arr = Array.from({ length: TARGET_CNT }).map(() =>
      fetch(HTTP_TARGET_URL, {
        method: 'GET',
        agent: httpAgentToSocks,
        headers: { type: 'echo' }
      })
        .then((req) => {
          if (req.status !== 200) {
            throw new Error(req.status)
          }

          return req.text()
        })
        .then(() => {
          cnt += 1
          return 200
        })
        .catch((e) => {
          console.log(e)
          return 500
        })
    )

    const result = await Promise.all(arr)

    expect(result.every((x) => x === 200)).toBeTruthy()
    expect(cnt).toBe(TARGET_CNT)

    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)
  })

  test('100 HTTPS-req -> HTTPS-agent -> tiny -> SOCKS-proxy -> target echo', async () => {
    let cnt = 0
    const TARGET_CNT = 100
    const arr = Array.from({ length: TARGET_CNT }).map(() =>
      fetch(HTTPS_TARGET_URL, {
        method: 'GET',
        agent: httpsAgentToSocks,
        headers: { type: 'echo' },
        rejectUnauthorized: false
      })
        .then((req) => {
          if (req.status !== 200) {
            throw new Error(req.status)
          }

          return req.text()
        })
        .then(() => {
          cnt += 1
          return 200
        })
        .catch(() => 500)
    )

    const result = await Promise.all(arr)

    expect(result.every((x) => x === 200)).toBeTruthy()
    expect(cnt).toBe(TARGET_CNT)

    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)
  })

  test('100 HTTP-req -> HTTP-agent -> tiny -> HTTP-proxy -> target echo', async () => {
    let cnt = 0
    const TARGET_CNT = 100
    const arr = Array.from({ length: TARGET_CNT }).map(() =>
      fetch(HTTP_TARGET_URL, {
        method: 'GET',
        agent: httpAgentToHttp,
        headers: { type: 'echo' },
        rejectUnauthorized: false
      })
        .then((req) => {
          if (req.status !== 200) {
            throw new Error(req.status)
          }

          return req.text()
        })
        .then(() => {
          cnt += 1
          return 200
        })
        .catch(() => 500)
    )

    const result = await Promise.all(arr)

    expect(result.every((x) => x === 200)).toBeTruthy()
    expect(cnt).toBe(TARGET_CNT)

    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)
  })

  test('100 HTTPS-req -> HTTPS-agent -> tiny -> HTTP-proxy -> target echo', async () => {
    let cnt = 0
    const TARGET_CNT = 100
    const arr = Array.from({ length: TARGET_CNT }).map(() =>
      fetch(HTTPS_TARGET_URL, {
        method: 'GET',
        agent: httpsAgentToHttp,
        headers: { type: 'echo' },
        rejectUnauthorized: false
      })
        .then((req) => {
          if (req.status !== 200) {
            throw new Error(req.status)
          }

          return req.text()
        })
        .then(() => {
          cnt += 1
          return 200
        })
        .catch(() => 500)
    )

    const result = await Promise.all(arr)

    expect(result.every((x) => x === 200)).toBeTruthy()
    expect(cnt).toBe(TARGET_CNT)

    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)
  })

  test('100 HTTP-req -> HTTPS-agent -> tiny -> HTTP-proxy -> target fall', async () => {
    const TARGET_CNT = 100
    const arr = Array.from({ length: TARGET_CNT }).map(() =>
      fetch(HTTP_TARGET_URL, {
        method: 'GET',
        agent: httpAgentToHttp,
        headers: { type: 'fall' },
        rejectUnauthorized: false
      })
        .then((res) => (res.status === 2000 ? 'good' : 'fall'))
        .catch(() => 'fall')
    )

    const result = await Promise.all(arr)

    expect(result.every((x) => x === 'fall')).toBeTruthy()
    expect(result.length).toBe(TARGET_CNT)
    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)
  })

  test('100 HTTPS-req -> HTTPS-agent -> tiny -> HTTP-proxy -> target fall', async () => {
    const TARGET_CNT = 100
    const arr = Array.from({ length: TARGET_CNT }).map(() =>
      fetch(HTTPS_TARGET_URL, {
        method: 'GET',
        agent: httpsAgentToHttp,
        headers: { type: 'fall' },
        rejectUnauthorized: false
      })
        .then(() => 'good')
        .catch(() => 'fall')
    )

    const result = await Promise.all(arr)

    expect(result.every((x) => x === 'fall')).toBeTruthy()
    expect(result.length).toBe(TARGET_CNT)

    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)
  })

  test('100 HTTP-req -> HTTP-agent -> tiny -> SOCKS-proxy -> target fall-res', async () => {
    const TARGET_CNT = 100
    const arr = Array.from({ length: TARGET_CNT }).map(() =>
      fetch(HTTP_TARGET_URL, {
        method: 'GET',
        agent: httpAgentToSocks,
        headers: { type: 'fall' },
        rejectUnauthorized: false
      })
        .then((res) => (res.status === 200 ? 'good' : 'fall'))
        .catch(() => 'fall')
    )

    const result = await Promise.all(arr)

    expect(result.every((x) => x === 'fall')).toBeTruthy()
    expect(result.length).toBe(TARGET_CNT)

    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)
  })

  test('100 HTTPS-req -> HTTPS-agent -> tiny -> SOCKS-proxy -> target res-fall', async () => {
    const TARGET_CNT = 100
    const arr = Array.from({ length: TARGET_CNT }).map(() =>
      fetch(HTTPS_TARGET_URL, {
        method: 'GET',
        agent: httpsAgentToSocks,
        headers: { type: 'fall' },
        rejectUnauthorized: false
      })
        .then((res) => (res.status === 200 ? 'good' : 'fall'))
        .catch(() => 'fall')
    )

    const result = await Promise.all(arr)

    expect(result.every((x) => x === 'fall')).toBeTruthy()
    expect(result.length).toBe(TARGET_CNT)

    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)
  })

  test('100 HTTP-req with ABORT -> HTTP-agent -> tiny -> HTTP-proxy -> target res with delay', async () => {
    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)
    const TARGET_CNT = 100

    const arr = Array.from({ length: TARGET_CNT }).map(() => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 1000)
      return fetch(HTTP_TARGET_URL, {
        method: 'GET',
        agent: httpAgentToHttp,
        headers: { type: 'delay-10000' },
        signal: controller.signal
      })
        .then((res) => res.text())
        .then(() => 'good')
        .catch(() => 'error')
    })

    await delay(500)
    const cnt = await getSocketCount()
    expect(cnt).toBeGreaterThan(TARGET_CNT)

    await Promise.all(arr)

    await delay(500)

    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)
  }, 15_000)

  test('1 HTTP-req with ABORT -> HTTP-agent -> tiny -> SOCKS-proxy -> target res with delay', async () => {
    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 1000)
    const req = fetch(HTTP_TARGET_URL, {
      method: 'GET',
      agent: httpAgentToSocks,
      headers: { type: 'delay-10000' },
      rejectUnauthorized: false,
      signal: controller.signal
    })
      .then((res) => res.text())
      .then(() => 'good')
      .catch(() => 'error')

    await delay(500)

    expect(await getSocketCount()).toBeGreaterThan(SOCKET_COUNTER)

    await req

    await delay(9000) // cleanup todo: check docker timeouts

    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)
  }, 15_000)

  test('100 HTTP-req with ABORT -> HTTP-agent -> tiny -> SOCKS-proxy -> target res with delay', async () => {
    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)

    const TARGET_CNT = 50

    const arr = Array.from({ length: TARGET_CNT }).map(() => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 1000)
      return fetch(HTTP_TARGET_URL, {
        method: 'GET',
        agent: httpAgentToSocks,
        headers: { type: 'delay-10000' },
        rejectUnauthorized: false,
        signal: controller.signal
      })
        .then((res) => res.text())
        .then(() => 'good')
        .catch(() => 'error')
    })

    await delay(500)

    expect(await getSocketCount()).toBeGreaterThan(TARGET_CNT)

    await Promise.all(arr)

    await new Promise((resolve) => setTimeout(resolve, 9000))

    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)
  }, 15_000)

  test('1 HTTPS-req with ABORT -> HTTPS-agent -> tiny -> HTTP-proxy -> target res with delay', async () => {
    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 1000)
    const req = fetch(HTTPS_TARGET_URL, {
      method: 'GET',
      agent: httpsAgentToHttp,
      headers: { type: 'delay-20000' },
      rejectUnauthorized: false,
      signal: controller.signal
    })
      .then((res) => res.text())
      .then(() => 'good')
      .catch(() => 'error')

    await delay(500)

    const cnt = await getSocketCount()

    expect(cnt).toBeGreaterThan(SOCKET_COUNTER)

    await req

    await delay(9000)

    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)
  }, 20_000)

  test('100 HTTPS-req with ABORT -> HTTPS-agent -> tiny -> HTTP-proxy -> target res with delay', async () => {
    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)
    const TARGET_CNT = 100

    const arr = Array.from({ length: TARGET_CNT }).map(() => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 1000)
      return fetch(HTTPS_TARGET_URL, {
        method: 'GET',
        agent: httpsAgentToHttp,
        headers: { type: 'delay-20000' },
        rejectUnauthorized: false,
        signal: controller.signal
      })
        .then((res) => res.text())
        .then(() => 'good')
        .catch(() => 'error')
    })

    await delay(500)

    const cnt = await getSocketCount()

    expect(cnt).toBeGreaterThan(TARGET_CNT)

    await Promise.all(arr)

    await delay(9000)

    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)
  }, 20_000)

  test('100 HTTPS-req with ABORT -> HTTPS-agent -> tiny -> SOCKS-proxy -> target res with delay', async () => {
    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)

    const TARGET_CNT = 100

    const arr = Array.from({ length: TARGET_CNT }).map(() => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 1000)
      return fetch(HTTPS_TARGET_URL, {
        method: 'GET',
        agent: httpsAgentToSocks,
        headers: { type: 'delay-10000' },
        rejectUnauthorized: false,
        signal: controller.signal
      })
        .then((res) => res.text())
        .then(() => 'good')
        .catch(() => 'error')
    })

    await delay(500)

    expect(await getSocketCount()).toBeGreaterThan(TARGET_CNT)

    expect((await Promise.all(arr)).filter((l) => l === 'error').length).toBe(TARGET_CNT)

    await delay(9000)

    expect(await getSocketCount()).toBeLessThanOrEqual(SOCKET_COUNTER)
  }, 15_000)

  test('check stat body response. HTTP-GET-req -> HTTP-agent -> tiny -> HTTP-proxy -> target return random bytes', async () => {
    await cleanStat()

    expect(await getStat()).toEqual({ downloadAcc: 0, uploadAcc: 0 })

    const dataLength = 5000

    const data = await fetch(HTTP_TARGET_URL, {
      method: 'GET',
      agent: httpAgentToHttp,
      headers: { type: `data-${dataLength}` }
    })
      .then((res) => res.text())
      .catch(() => 'error')

    expect(data.length).toBe(dataLength)

    const res = await getStat()

    expect(res.downloadAcc).toBeGreaterThan(dataLength)
  })

  test('check stat body response. HTTP-GET-req -> HTTP-agent -> tiny -> SOCKS-proxy -> target return random bytes', async () => {
    await cleanStat()
    expect(await getStat()).toEqual({ downloadAcc: 0, uploadAcc: 0 })

    const dataLength = 5000

    const data = await fetch(HTTP_TARGET_URL, {
      method: 'GET',
      agent: httpAgentToSocks,
      headers: { type: `data-${dataLength}` }
    })
      .then((res) => res.text())
      .catch(() => 'error')

    expect(data.length).toBe(dataLength)

    const res = await getStat()

    expect(res.downloadAcc).toBeGreaterThan(dataLength)
  })

  test('check stat request. HTTP-GET-req -> HTTP-agent -> tiny -> HTTP-proxy -> target return random bytes', async () => {
    await cleanStat()

    expect(await getStat()).toEqual({ downloadAcc: 0, uploadAcc: 0 })

    const dataLength = 5000

    const proxyRequest = [
      `GET ${HTTP_TARGET_URL} HTTP/1.1`,
      `Host: localhost:${HTTP_TINY_PORT}`,
      `type: data-${dataLength}`,
      `Proxy-Connection: close`
    ]
      .join('\r\n')
      .concat('\r\n\r\n')

    await new Promise((resolve) => {
      const socket = net.connect(
        {
          hostname: 'localhost',
          port: HTTP_TINY_PORT
        },
        () => {
          socket.write(proxyRequest)
          socket.on('data', () => {})
          socket.on('end', resolve)
        }
      )
    })

    const res = await getStat()

    expect(res.uploadAcc).toBe(proxyRequest.length)
  })

  test('check stat request. HTTP-POST-req -> HTTP-agent -> tiny -> SOCKS-proxy -> target return random bytes', async () => {
    await cleanStat()

    expect(await getStat()).toEqual({ downloadAcc: 0, uploadAcc: 0 })

    const dataLength = 5000

    const proxyRequest = [
      `GET ${HTTP_TARGET_URL} HTTP/1.1`,
      `Host: localhost:${HTTP_TINY_PORT}`,
      `type: data-${dataLength}`,
      `Proxy-Connection: close`
    ]
      .join('\r\n')
      .concat('\r\n\r\n')

    await new Promise((resolve) => {
      const socket = net.connect(
        {
          hostname: 'localhost',
          port: SOCKS_TINY_PORT
        },
        () => {
          socket.write(proxyRequest)
          socket.on('data', () => {})
          socket.on('end', resolve)
        }
      )
    })

    const res = await getStat()

    expect(res.uploadAcc).toBe(proxyRequest.length)
  })

  test('check stat body request. HTTP-POST-req -> HTTP-agent -> tiny -> HTTP-proxy -> target return random bytes', async () => {
    await cleanStat()

    expect(await getStat()).toEqual({ downloadAcc: 0, uploadAcc: 0 })

    const dataLength = 5000

    const proxyRequest = [
      `POST ${HTTP_TARGET_URL} HTTP/1.1`,
      `Host: localhost:${HTTP_TINY_PORT}`,
      `type: data-${dataLength}`,
      `Content-Length: ${dataLength}`,
      `Proxy-Connection: close`
    ]
      .join('\r\n')
      .concat('\r\n\r\n')
      .concat('t'.repeat(dataLength))

    await new Promise((resolve) => {
      const socket = net.connect(
        {
          hostname: 'localhost',
          port: HTTP_TINY_PORT
        },
        () => {
          socket.write(proxyRequest)
          socket.on('data', () => {})
          socket.on('end', resolve)
        }
      )
    })

    const res = await getStat()

    expect(res.uploadAcc).toBe(proxyRequest.length)
  })

  test('check stat body request. HTTP-GET-req -> HTTP-agent -> tiny -> SOCKS-proxy -> target return random bytes', async () => {
    await cleanStat()

    expect(await getStat()).toEqual({ downloadAcc: 0, uploadAcc: 0 })

    const dataLength = 5000

    const proxyRequest = [
      `POST ${HTTP_TARGET_URL} HTTP/1.1`,
      `Host: localhost:${HTTP_TINY_PORT}`,
      `type: data-${dataLength}`,
      `Content-Length: ${dataLength}`,
      `Proxy-Connection: close`
    ]
      .join('\r\n')
      .concat('\r\n\r\n')
      .concat('t'.repeat(dataLength))

    await new Promise((resolve) => {
      const socket = net.connect(
        {
          hostname: 'localhost',
          port: SOCKS_TINY_PORT
        },
        () => {
          socket.write(proxyRequest)
          socket.on('data', () => {})
          socket.on('end', resolve)
        }
      )
    })

    const res = await getStat()

    expect(res.uploadAcc).toBe(proxyRequest.length)
  })

  test('10% traffic check tls. HTTPS-GET-req -> HTTPS-agent -> tiny -> HTTP-proxy -> target return random bytes', async () => {
    const { rxBytes: receivedBytesStart } = await getContainerStats('proxy')

    await cleanStat()

    expect(await getStat()).toEqual({ downloadAcc: 0, uploadAcc: 0 })

    const dataLength = 5000

    for (let i = 0; i < 40; i++) {
      const text = await fetch(HTTPS_TARGET_URL, {
        method: 'POST',
        agent: httpsAgentToHttp,
        headers: { type: `data-${dataLength}` },
        body: Buffer.allocUnsafe(dataLength).toString()
      }).then((res) => res.text())

      expect(text.length).toBe(dataLength)
    }

    const { rxBytes: receivedBytesEnd } = await getContainerStats('proxy')
    const { downloadAcc, uploadAcc } = await getStat()

    const statSum = downloadAcc + uploadAcc

    const delta = receivedBytesEnd - receivedBytesStart

    expect(Math.abs(statSum - delta)).toBeLessThan(0.1 * delta)
  })

  test('10% traffic check tls. HTTPS-GET-req -> HTTPS-agent -> tiny -> HTTP-SOCKS-> target return random bytes', async () => {
    const { rxBytes: receivedBytesStart } = await getContainerStats('proxy')

    await cleanStat()

    expect(await getStat()).toEqual({ downloadAcc: 0, uploadAcc: 0 })

    const dataLength = 100000

    for (let i = 0; i < 40; i++) {
      const text = await fetch(HTTPS_TARGET_URL, {
        method: 'POST',
        agent: httpsAgentToSocks,
        headers: { type: `data-${dataLength}` },
        body: Buffer.allocUnsafe(dataLength).toString()
      }).then((res) => res.text())

      expect(text.length).toBe(dataLength)

      await delay(200)
    }

    const { rxBytes: receivedBytesEnd } = await getContainerStats('proxy')
    const { downloadAcc, uploadAcc } = await getStat()
    const statSum = downloadAcc + uploadAcc

    const delta = receivedBytesEnd - receivedBytesStart

    expect(Math.abs(statSum - delta)).toBeLessThan(0.1 * delta)
  }, 20_000)
})
