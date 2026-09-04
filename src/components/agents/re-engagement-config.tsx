'use client'

// ============================================================
// Re-engagement stages config — the AI tab's newest section.
//
// One row per "silence bucket": name it, pick how many hours of
// silence trigger it, pick which approved Meta template to send,
// pick text vs product-carousel, toggle on/off. Add as many
// stages as you want (max enforced server-side); the cron
// evaluates them in ascending order of hours and each contact
// receives each stage at most once.
//
// Loads:
//   GET /api/account/re-engagement/stages
//   GET /api/account/re-engagement/templates  (approved templates)
//
// Writes (admin only — button hidden for members):
//   POST   /api/account/re-engagement/stages
//   PATCH  /api/account/re-engagement/stages/[id]
//   DELETE /api/account/re-engagement/stages/[id]
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Plus, Trash2, Timer, LayoutGrid, Type, Info } from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { canEditSettings } from '@/lib/auth/roles'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface Stage {
  id: string
  name: string
  hours_after: number
  template_name: string
  template_language: string
  template_type: 'text' | 'carousel'
  enabled: boolean
}

interface ApprovedTemplate {
  name: string
  language: string
  category: string
  status: string
}

interface NewStageDraft {
  name: string
  hours_after: string
  template_name: string
  template_language: string
  template_type: 'text' | 'carousel'
}

const EMPTY_DRAFT: NewStageDraft = {
  name: '',
  hours_after: '24',
  template_name: '',
  template_language: 'en',
  template_type: 'text',
}

function formatHours(h: number): string {
  if (h < 24) return `${h}h`
  const days = h / 24
  if (Number.isInteger(days)) return `${days}d`
  return `${h}h`
}

export function ReEngagementConfig() {
  const { accountRole } = useAuth()
  const canEdit = accountRole ? canEditSettings(accountRole) : false

  const [stages, setStages] = useState<Stage[]>([])
  const [templates, setTemplates] = useState<ApprovedTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<NewStageDraft>(EMPTY_DRAFT)
  const [creating, setCreating] = useState(false)
  const [showDraft, setShowDraft] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [stagesRes, tmplRes] = await Promise.all([
        fetch('/api/account/re-engagement/stages'),
        fetch('/api/account/re-engagement/templates'),
      ])
      const stagesData = await stagesRes.json().catch(() => ({}))
      const tmplData = await tmplRes.json().catch(() => ({}))
      setStages(Array.isArray(stagesData?.stages) ? stagesData.stages : [])
      setTemplates(Array.isArray(tmplData?.templates) ? tmplData.templates : [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const templateOptions = useMemo(() => {
    // De-dupe by name — same template may have multiple language rows.
    const seen = new Set<string>()
    return templates.filter((t) => {
      if (seen.has(t.name)) return false
      seen.add(t.name)
      return true
    })
  }, [templates])

  const createStage = useCallback(async () => {
    const hours = Number(draft.hours_after)
    if (!draft.name.trim()) {
      toast.error('Give the stage a name')
      return
    }
    if (!Number.isFinite(hours) || hours <= 0) {
      toast.error('Hours must be a positive number')
      return
    }
    if (!draft.template_name) {
      toast.error('Pick a template')
      return
    }
    setCreating(true)
    try {
      const res = await fetch('/api/account/re-engagement/stages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: draft.name.trim(),
          hours_after: hours,
          template_name: draft.template_name,
          template_language: draft.template_language || 'en',
          template_type: draft.template_type,
          enabled: true,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data?.error ?? 'Failed to create stage')
        return
      }
      toast.success('Stage added')
      setDraft(EMPTY_DRAFT)
      setShowDraft(false)
      await load()
    } finally {
      setCreating(false)
    }
  }, [draft, load])

  const patchStage = useCallback(
    async (id: string, patch: Partial<Stage>) => {
      // Optimistic update — snap back on failure.
      const prev = stages
      setStages((s) => s.map((row) => (row.id === id ? { ...row, ...patch } : row)))
      const res = await fetch(`/api/account/re-engagement/stages/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast.error(data?.error ?? 'Update failed')
        setStages(prev)
      }
    },
    [stages],
  )

  const deleteStage = useCallback(
    async (id: string) => {
      if (!confirm('Delete this stage? Contacts who already received it will not be re-sent — this only prevents future sends.')) return
      const res = await fetch(`/api/account/re-engagement/stages/${id}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast.error(data?.error ?? 'Delete failed')
        return
      }
      toast.success('Stage removed')
      setStages((s) => s.filter((row) => row.id !== id))
    },
    [],
  )

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Timer className="h-5 w-5 text-primary" /> Re-engagement stages
          </CardTitle>
          <CardDescription>
            When a cold customer goes silent, an hourly job sends them one of these
            Meta templates. Each stage fires <strong>once per customer</strong> — add as many
            as you want (3h nudge, 24h check-in, 7d we-miss-you, 30d last-call). Only
            contacts graded <strong>cold</strong> are targeted; hot/warm leads never get these.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {templateOptions.length === 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
              <Info className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                No approved WhatsApp templates yet. Create a MARKETING template in Meta
                Business Manager, wait for approval, then sync it under WhatsApp →
                Templates before configuring a stage here.
              </div>
            </div>
          ) : null}

          {stages.length === 0 && !showDraft ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No stages yet. Add one to start reactivating cold customers.
            </div>
          ) : null}

          <div className="space-y-3 mt-3">
            {stages.map((stage) => (
              <StageRow
                key={stage.id}
                stage={stage}
                templates={templateOptions}
                canEdit={canEdit}
                onPatch={(patch) => patchStage(stage.id, patch)}
                onDelete={() => deleteStage(stage.id)}
              />
            ))}
          </div>

          {showDraft && canEdit ? (
            <div className="mt-4 space-y-3 rounded-lg border p-4 bg-muted/30">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="draft-name">Stage name</Label>
                  <Input
                    id="draft-name"
                    placeholder="e.g. 3h nudge"
                    value={draft.name}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  />
                </div>
                <div>
                  <Label htmlFor="draft-hours">Silence hours before sending</Label>
                  <Input
                    id="draft-hours"
                    type="number"
                    min={1}
                    step={1}
                    value={draft.hours_after}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, hours_after: e.target.value }))
                    }
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Examples: 3 = 3h, 24 = 1d, 72 = 3d, 168 = 7d, 720 = 30d
                  </p>
                </div>
                <div>
                  <Label>Template</Label>
                  <Select
                    value={draft.template_name}
                    onValueChange={(v) => {
                      const name = v ?? ''
                      const picked = templateOptions.find((t) => t.name === name)
                      setDraft((d) => ({
                        ...d,
                        template_name: name,
                        template_language: picked?.language ?? d.template_language,
                      }))
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Pick an approved template" />
                    </SelectTrigger>
                    <SelectContent>
                      {templateOptions.map((t) => (
                        <SelectItem key={t.name} value={t.name}>
                          {t.name}
                          <span className="ml-2 text-xs text-muted-foreground">
                            {t.category}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Type</Label>
                  <Select
                    value={draft.template_type}
                    onValueChange={(v) =>
                      setDraft((d) => ({
                        ...d,
                        template_type: v === 'carousel' ? 'carousel' : 'text',
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text">
                        <span className="inline-flex items-center gap-2">
                          <Type className="h-3.5 w-3.5" /> Text template
                        </span>
                      </SelectItem>
                      <SelectItem value="carousel">
                        <span className="inline-flex items-center gap-2">
                          <LayoutGrid className="h-3.5 w-3.5" /> Product carousel
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Carousel injects your active products (image, price, Shop Now link)
                    into a carousel template — pick a Meta carousel template above.
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDraft(EMPTY_DRAFT)
                    setShowDraft(false)
                  }}
                  disabled={creating}
                >
                  Cancel
                </Button>
                <Button onClick={createStage} disabled={creating}>
                  {creating ? (
                    <>
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Adding…
                    </>
                  ) : (
                    'Add stage'
                  )}
                </Button>
              </div>
            </div>
          ) : null}

          {canEdit && !showDraft ? (
            <Button
              variant="outline"
              onClick={() => setShowDraft(true)}
              className="mt-4"
              disabled={templateOptions.length === 0}
            >
              <Plus className="mr-1.5 h-4 w-4" /> Add stage
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How it fires</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            The hourly cron looks at each customer graded <strong>cold</strong> and, for every
            enabled stage, sends the template exactly once when their silence
            crosses the configured hours. Stages fire in ascending order of hours;
            a customer never receives two stages in the same run.
          </p>
          <p>
            Cost: MARKETING templates ~₹0.85 per send in India (UTILITY is cheaper).
            To pause everything without deleting, disable each stage — deleting a
            stage also drops its send-history rows, so re-adding it will resend to
            people who already received it. Prefer disable → re-enable for reversible pauses.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function StageRow({
  stage,
  templates,
  canEdit,
  onPatch,
  onDelete,
}: {
  stage: Stage
  templates: ApprovedTemplate[]
  canEdit: boolean
  onPatch: (patch: Partial<Stage>) => void
  onDelete: () => void
}) {
  const [hoursDraft, setHoursDraft] = useState(String(stage.hours_after))

  useEffect(() => {
    setHoursDraft(String(stage.hours_after))
  }, [stage.hours_after])

  return (
    <div className="rounded-lg border p-4 bg-background">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center gap-2">
            <Input
              value={stage.name}
              onChange={(e) => onPatch({ name: e.target.value })}
              disabled={!canEdit}
              className="text-sm font-medium max-w-xs"
            />
            <span className="text-xs text-muted-foreground shrink-0">
              fires at {formatHours(stage.hours_after)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-1.5">
            <Switch
              checked={stage.enabled}
              onCheckedChange={(v) => onPatch({ enabled: v })}
              disabled={!canEdit}
              id={`enabled-${stage.id}`}
            />
            <Label htmlFor={`enabled-${stage.id}`} className="text-xs text-muted-foreground">
              {stage.enabled ? 'Enabled' : 'Paused'}
            </Label>
          </div>
          {canEdit ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              aria-label="Delete stage"
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <Label className="text-xs">Hours of silence</Label>
          <Input
            type="number"
            min={1}
            step={1}
            value={hoursDraft}
            onChange={(e) => setHoursDraft(e.target.value)}
            onBlur={() => {
              const n = Number(hoursDraft)
              if (Number.isFinite(n) && n > 0 && n !== stage.hours_after) {
                onPatch({ hours_after: Math.floor(n) })
              } else {
                setHoursDraft(String(stage.hours_after))
              }
            }}
            disabled={!canEdit}
          />
        </div>
        <div>
          <Label className="text-xs">Template</Label>
          <Select
            value={stage.template_name}
            onValueChange={(v) => {
              const name = v ?? ''
              if (!name) return
              const picked = templates.find((t) => t.name === name)
              onPatch({
                template_name: name,
                template_language: picked?.language ?? stage.template_language,
              })
            }}
            disabled={!canEdit}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {templates.map((t) => (
                <SelectItem key={t.name} value={t.name}>
                  {t.name}
                </SelectItem>
              ))}
              {/* Keep the current value selectable even if it was
                  deleted / not approved any more, so the row shows
                  what's live server-side. */}
              {!templates.some((t) => t.name === stage.template_name) ? (
                <SelectItem value={stage.template_name}>
                  {stage.template_name} (not approved)
                </SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Type</Label>
          <Select
            value={stage.template_type}
            onValueChange={(v) =>
              onPatch({ template_type: v === 'carousel' ? 'carousel' : 'text' })
            }
            disabled={!canEdit}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="text">Text template</SelectItem>
              <SelectItem value="carousel">Product carousel</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  )
}
