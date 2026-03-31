import { Request, Response, NextFunction } from 'express'

interface HttpError extends Error {
  status?: number
}

function errorHandler(
  err: HttpError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  console.error('[Error]', err.message, err.stack)
  res.status(err.status ?? 500).json({ error: err.message || 'Internal server error' })
}

export { errorHandler }
