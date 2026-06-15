import { describe, expect, it } from 'vitest'
import { createSettleBus } from './settle-bus'

describe('createSettleBus', () => {
  it('resolves an armed waiter with the settle result', async () => {
    const bus = createSettleBus(1000)
    const p = bus.arm()
    bus.settle('completed')
    await expect(p).resolves.toEqual({ result: 'completed' })
  })

  it('passes the detail through on error', async () => {
    const bus = createSettleBus(1000)
    const p = bus.arm()
    bus.settle('error', 'No iron-ore found')
    await expect(p).resolves.toEqual({ result: 'error', detail: 'No iron-ore found' })
  })

  it('times out when never settled', async () => {
    const bus = createSettleBus(20)
    await expect(bus.arm()).resolves.toEqual({ result: 'timeout' })
  })

  it('resolves cancelled on cancel()', async () => {
    const bus = createSettleBus(1000)
    const p = bus.arm()
    bus.cancel()
    await expect(p).resolves.toEqual({ result: 'cancelled' })
  })

  it('is a no-op to settle with no armed waiter', () => {
    const bus = createSettleBus(1000)
    expect(() => bus.settle('completed')).not.toThrow()
  })

  it('supersedes a previous armed waiter when re-armed', async () => {
    const bus = createSettleBus(1000)
    const first = bus.arm()
    const second = bus.arm()
    bus.settle('completed')
    await expect(first).resolves.toEqual({ result: 'cancelled' })
    await expect(second).resolves.toEqual({ result: 'completed' })
  })

  it('attaches a stashed result to the next completed settle', async () => {
    const bus = createSettleBus(1000)
    const p = bus.arm()
    bus.result({ op: 'place', x: 5, y: 12, status: 'no_fuel' })
    bus.settle('completed')
    await expect(p).resolves.toEqual({ result: 'completed', data: { op: 'place', x: 5, y: 12, status: 'no_fuel' } })
  })

  it('does not attach result data to an error settle', async () => {
    const bus = createSettleBus(1000)
    const p = bus.arm()
    bus.result({ x: 1, y: 2 })
    bus.settle('error', 'blocked')
    await expect(p).resolves.toEqual({ result: 'error', detail: 'blocked' })
  })

  it('clears a stashed result on re-arm so no stale data leaks to the next op', async () => {
    const bus = createSettleBus(1000)
    const p1 = bus.arm()
    bus.result({ x: 1, y: 2 })
    bus.settle('completed')
    await expect(p1).resolves.toEqual({ result: 'completed', data: { x: 1, y: 2 } })
    const p2 = bus.arm()
    bus.settle('completed')
    await expect(p2).resolves.toEqual({ result: 'completed' })
  })
})
