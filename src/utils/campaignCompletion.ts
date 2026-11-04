import { supabaseAdmin } from '../config/supabase'
import { releaseFriendlyWarmup } from './friendlyWarmup'

async function getPrimarySequenceId(campaignId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('campaign_sequences')
    .select('sequence_id')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return (data as { sequence_id: string } | null)?.sequence_id ?? null
}

async function getSentStepsByLead(
  campaignId: string,
  sequenceId: string
): Promise<Map<string, Set<string>>> {
  const { data: logs } = await supabaseAdmin
    .from('email_logs')
    .select('lead_id, step_id')
    .eq('campaign_id', campaignId)
    .eq('sequence_id', sequenceId)
    .eq('status', 'sent')

  const map = new Map<string, Set<string>>()
  for (const row of logs ?? []) {
    const lid = (row as { lead_id: string; step_id: string }).lead_id
    const sid = (row as { step_id: string }).step_id
    if (!map.has(lid)) map.set(lid, new Set())
    map.get(lid)!.add(sid)
  }
  return map
}

/** Progress uses the first linked sequence. steps_executed = min sent-step count among active leads (bottleneck). */
export async function computeCampaignSequenceProgress(
  campaignId: string
): Promise<{ steps_total: number; steps_executed: number }> {
  const sequenceId = await getPrimarySequenceId(campaignId)
  if (!sequenceId) {
    return { steps_total: 0, steps_executed: 0 }
  }

  const { count } = await supabaseAdmin
    .from('sequence_steps')
    .select('id', { count: 'exact', head: true })
    .eq('sequence_id', sequenceId)
  const steps_total = count ?? 0

  const { data: leads } = await supabaseAdmin
    .from('leads')
    .select('id, status')
    .eq('campaign_id', campaignId)

  const leadList = (leads ?? []) as { id: string; status: string }[]
  if (leadList.length === 0 || steps_total === 0) {
    return { steps_total, steps_executed: 0 }
  }

  const sentMap = await getSentStepsByLead(campaignId, sequenceId)

  const activeLeads = leadList.filter((l) => l.status === 'active')
  if (activeLeads.length === 0) {
    const counts = leadList.map((l) => sentMap.get(l.id)?.size ?? 0)
    const maxReached = Math.min(steps_total, Math.max(0, ...counts))
    return { steps_total, steps_executed: maxReached }
  }

  const activeCounts = activeLeads.map((l) => sentMap.get(l.id)?.size ?? 0)
  const steps_executed = Math.min(...activeCounts)
  return { steps_total, steps_executed }
}

/** Mark campaign completed when every active lead has a sent log for each step in the primary sequence. */
export async function checkAndCompleteCampaign(campaignId: string): Promise<void> {
  const { data: campaign } = await supabaseAdmin
    .from('campaigns')
    .select('status, is_warmup')
    .eq('id', campaignId)
    .single()

  if (!campaign || (campaign as { status: string }).status !== 'active') {
    return
  }

  const sequenceId = await getPrimarySequenceId(campaignId)
  if (!sequenceId) return

  const { count } = await supabaseAdmin
    .from('sequence_steps')
    .select('id', { count: 'exact', head: true })
    .eq('sequence_id', sequenceId)
  const steps_total = count ?? 0
  if (steps_total === 0) return

  const { data: leads } = await supabaseAdmin
    .from('leads')
    .select('id, status')
    .eq('campaign_id', campaignId)

  const leadList = (leads ?? []) as { id: string; status: string }[]
  if (leadList.length === 0) return

  const sentMap = await getSentStepsByLead(campaignId, sequenceId)

  for (const lead of leadList) {
    if (lead.status !== 'active') continue
    const n = sentMap.get(lead.id)?.size ?? 0
    if (n < steps_total) return
  }

  const { error } = await supabaseAdmin
    .from('campaigns')
    .update({ status: 'completed' })
    .eq('id', campaignId)
    .eq('status', 'active')

  if (error) {
    console.error('[CampaignCompletion] Failed to mark completed:', error.message)
    return
  }

  if ((campaign as { is_warmup?: boolean }).is_warmup) {
    await releaseFriendlyWarmup(campaignId)
  }
}
