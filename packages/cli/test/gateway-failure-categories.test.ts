import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { fetchCar, GatewayError } from '../src/gateway.ts'

test('5xx response is categorized as source_gateway_5xx', async () => {
  const srv = createServer((_, res) => {
    res.writeHead(503)
    res.end()
  })
  await new Promise<void>((r) => srv.listen(0, r))
  const port = (srv.address() as any).port
  try {
    await fetchCar(`http://127.0.0.1:${port}`, 'bafkreia5wnkvwifodgqmkgyjgdtz77xpibnq25rnsqccq6nxbpmyc5fqoi')
    assert.fail('expected throw')
  } catch (err) {
    assert.ok(err instanceof GatewayError)
    assert.equal((err as GatewayError).category, 'source_gateway_5xx')
  } finally {
    srv.close()
  }
})

test('429 response is categorized as source_gateway_429', async () => {
  const srv = createServer((_, res) => {
    res.writeHead(429)
    res.end()
  })
  await new Promise<void>((r) => srv.listen(0, r))
  const port = (srv.address() as any).port
  try {
    await fetchCar(`http://127.0.0.1:${port}`, 'bafkreia5wnkvwifodgqmkgyjgdtz77xpibnq25rnsqccq6nxbpmyc5fqoi')
    assert.fail('expected throw')
  } catch (err) {
    assert.equal((err as GatewayError).category, 'source_gateway_429')
  } finally {
    srv.close()
  }
})

test('connection refused is categorized as source_gateway_network', async () => {
  // Port 1 is reserved and never accepts connections.
  try {
    await fetchCar('http://127.0.0.1:1', 'bafkreia5wnkvwifodgqmkgyjgdtz77xpibnq25rnsqccq6nxbpmyc5fqoi')
    assert.fail('expected throw')
  } catch (err) {
    assert.ok(err instanceof GatewayError, 'expected GatewayError')
    assert.equal((err as GatewayError).category, 'source_gateway_network')
  }
})

test('unresolvable hostname is categorized as source_gateway_network', async () => {
  try {
    await fetchCar('http://nonexistent.invalid.', 'bafkreia5wnkvwifodgqmkgyjgdtz77xpibnq25rnsqccq6nxbpmyc5fqoi')
    assert.fail('expected throw')
  } catch (err) {
    assert.equal((err as GatewayError).category, 'source_gateway_network')
  }
})

test('abort signal categorizes as source_gateway_timeout', async () => {
  const srv = createServer(() => {
    /* never respond */
  })
  await new Promise<void>((r) => srv.listen(0, r))
  const port = (srv.address() as any).port
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 100)
  try {
    await fetchCar(
      `http://127.0.0.1:${port}`,
      'bafkreia5wnkvwifodgqmkgyjgdtz77xpibnq25rnsqccq6nxbpmyc5fqoi',
      ctrl.signal
    )
    assert.fail('expected throw')
  } catch (err) {
    assert.equal((err as GatewayError).category, 'source_gateway_timeout')
  } finally {
    srv.close()
  }
})
