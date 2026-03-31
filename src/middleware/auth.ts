import { Request, Response, NextFunction } from 'express'
import { supabaseAdmin } from '../config/supabase'

async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Bearer token' })
    return
  }
  const token = header.split(' ')[1]
  const {
    data: { user },
    error,
  } = await supabaseAdmin.auth.getUser(token)
  if (error || !user) {
    res.status(401).json({ error: 'Invalid or expired token' })
    return
  }

  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('users')
    .select('company_id, role')
    .eq('id', user.id)
    .single()

  if (profileErr || !profile) {
    res.status(401).json({ error: 'User profile not found' })
    return
  }

  req.user = {
    id: user.id,
    email: user.email ?? '',
    company_id: profile.company_id as string,
    role: profile.role as 'owner' | 'admin' | 'member',
  }
  next()
}

export { authMiddleware }
