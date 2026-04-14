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

  let companyId = profile.company_id as string

  // If client requests a specific company, validate membership
  const requestedCompanyId = req.headers['x-company-id'] as string | undefined
  if (requestedCompanyId && requestedCompanyId !== companyId) {
    try {
      const { data: membership } = await supabaseAdmin
        .from('user_companies')
        .select('company_id')
        .eq('user_id', user.id)
        .eq('company_id', requestedCompanyId)
        .single()
      if (membership) {
        companyId = requestedCompanyId
      }
      // If no membership found, silently fall back to default company
    } catch {
      // user_companies table may not exist yet — fall back to default
    }
  }

  req.user = {
    id: user.id,
    email: user.email ?? '',
    company_id: companyId,
    role: profile.role as 'owner' | 'admin' | 'member' | 'global_admin',
  }
  next()
}

export { authMiddleware }
