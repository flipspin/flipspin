import { describe, expect, it } from 'vitest'
import { homeRoute } from './RouteSteps'

describe('homeRoute', () => {
  it.each([
    [['10.1.2.0/24'], '10.1.2.0/23'],
    [['10.1.3.0/24'], '10.1.2.0/23'],
    [['172.16.4.0/23'], '172.16.4.0/22'],
    [['10.20.0.0/16'], '10.20.0.0/15'],
    [['10.1.2.0/30'], '10.1.2.0/29'],
  ])('widens %j by one bit', (networks, expected) => {
    expect(homeRoute(networks)).toBe(expected)
  })

  it.each([
    [undefined],
    [[]],
    [['10.0.0.0/8']],
    [['10.1.2.0/31']],
    [['192.0.2.0/24']],
    [['169.254.0.0/16']],
    [['fd00::/64']],
    [['10.1.2.999/24']],
    [['not a network']],
  ])('offers nothing for %j', networks => {
    expect(homeRoute(networks as string[] | undefined)).toBeNull()
  })
})
