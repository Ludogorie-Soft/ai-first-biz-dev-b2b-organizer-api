import { supabaseAdmin } from '../config/supabase'

/** Reply stats from email_logs (one row per categorized reply). */
export async function computeCampaignReplyStats(
  campaignIds: string[]
): Promise<Map<string, { total: number; positive: number }>> {
  const result = new Map<string, { total: number; positive: number }>()
  for (const id of campaignIds) result.set(id, { total: 0, positive: 0 })
  if (campaignIds.length === 0) return result

  const { data: rows } = await supabaseAdmin
    .from('email_logs')
    .select('campaign_id, reply_category')
    .in('campaign_id', campaignIds)

  for (const row of rows ?? [] as { campaign_id: string; reply_category: string | null }[]) {
    if (!row.reply_category) continue
    const cur = result.get(row.campaign_id) ?? { total: 0, positive: 0 }
    cur.total++
    if (row.reply_category === 'positive') cur.positive++
    result.set(row.campaign_id, cur)
  }
  return result
}

/**
 * Batch sequence progress (same rules as computeCampaignSequenceProgress): first linked sequence,
 * steps_executed = min sent-step count among active leads, or max among inactive when none active.
 */
export async function computeCampaignListProgress(
  campaignIds: string[]
): Promise<Map<string, { steps_total: number; steps_executed: number }>> {
  const result = new Map<string, { steps_total: number; steps_executed: number }>()
  for (const id of campaignIds) result.set(id, { steps_total: 0, steps_executed: 0 })
  if (campaignIds.length === 0) return result

  const { data: csRows } = await supabaseAdmin
    .from('campaign_sequences')
    .select('campaign_id, sequence_id, created_at')
    .in('campaign_id', campaignIds)

  const sortedCs = [...(csRows ?? [])] as {
    campaign_id: string
    sequence_id: string
    created_at: string
  }[]
  sortedCs.sort((a, b) => {
    if (a.campaign_id !== b.campaign_id) return a.campaign_id.localeCompare(b.campaign_id)
    return a.created_at.localeCompare(b.created_at)
  })

  const campaignToSequence = new Map<string, string>()
  for (const row of sortedCs) {
    if (!campaignToSequence.has(row.campaign_id)) {
      campaignToSequence.set(row.campaign_id, row.sequence_id)
    }
  }

  const sequenceIds = [...new Set(campaignToSequence.values())]
  if (sequenceIds.length === 0) return result

  const { data: stepRows } = await supabaseAdmin
    .from('sequence_steps')
    .select('sequence_id')
    .in('sequence_id', sequenceIds)

  const stepsPerSequence = new Map<string, number>()
  for (const sid of sequenceIds) stepsPerSequence.set(sid, 0)
  for (const row of stepRows ?? [] as { sequence_id: string }[]) {
    stepsPerSequence.set(row.sequence_id, (stepsPerSequence.get(row.sequence_id) ?? 0) + 1)
  }

  const { data: leadRows } = await supabaseAdmin
    .from('leads')
    .select('id, campaign_id, status')
    .in('campaign_id', campaignIds)

  const { data: logRows } = await supabaseAdmin
    .from('email_logs')
    .select('campaign_id, sequence_id, lead_id, step_id')
    .in('campaign_id', campaignIds)
    .eq('status', 'sent')

  const sentKey = (campaignId: string, sequenceId: string, leadId: string) =>
    `${campaignId}:${sequenceId}:${leadId}`
  const sentSets = new Map<string, Set<string>>()

  for (const row of logRows ?? [] as {
    campaign_id: string
    sequence_id: string
    lead_id: string
    step_id: string
  }[]) {
    const seq = campaignToSequence.get(row.campaign_id)
    if (!seq || row.sequence_id !== seq) continue
    const key = sentKey(row.campaign_id, seq, row.lead_id)
    if (!sentSets.has(key)) sentSets.set(key, new Set())
    sentSets.get(key)!.add(row.step_id)
  }

  const countSentFor = (campaignId: string, leadId: string): number => {
    const seq = campaignToSequence.get(campaignId)
    if (!seq) return 0
    return sentSets.get(sentKey(campaignId, seq, leadId))?.size ?? 0
  }

  const leadsByCampaign = new Map<string, { id: string; status: string }[]>()
  for (const l of leadRows ?? [] as { id: string; campaign_id: string; status: string }[]) {
    if (!leadsByCampaign.has(l.campaign_id)) leadsByCampaign.set(l.campaign_id, [])
    leadsByCampaign.get(l.campaign_id)!.push({ id: l.id, status: l.status })
  }

  for (const campaignId of campaignIds) {
    const seqId = campaignToSequence.get(campaignId)
    const steps_total = seqId ? (stepsPerSequence.get(seqId) ?? 0) : 0
    const leads = leadsByCampaign.get(campaignId) ?? []
    if (leads.length === 0 || steps_total === 0) {
      result.set(campaignId, { steps_total, steps_executed: 0 })
      continue
    }
    const activeLeads = leads.filter((l) => l.status === 'active')
    let steps_executed: number
    if (activeLeads.length === 0) {
      const counts = leads.map((l) => countSentFor(campaignId, l.id))
      steps_executed = Math.min(steps_total, Math.max(0, ...counts))
    } else {
      const activeCounts = activeLeads.map((l) => countSentFor(campaignId, l.id))
      steps_executed = Math.min(...activeCounts)
    }
    result.set(campaignId, { steps_total, steps_executed })
  }

  return result
}
