function withTimestamp(method: typeof console.log): typeof console.log {
  return (...args: Parameters<typeof console.log>) => {
    method(`${new Date().toISOString()}`, ...args)
  }
}

console.log = withTimestamp(console.log.bind(console))
console.warn = withTimestamp(console.warn.bind(console))
console.error = withTimestamp(console.error.bind(console))
console.info = withTimestamp(console.info.bind(console))
