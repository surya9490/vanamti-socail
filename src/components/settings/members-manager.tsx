'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, ShieldAlert, Trash2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ALL_SCOPES, type Role, type Scope, type UserStatus } from '@/types';

interface Member {
  id: string;
  user_id: string;
  full_name: string;
  email: string;
  avatar_url: string | null;
  role: Role;
  status: UserStatus;
  scopes: Scope[];
  created_at: string;
}

const STATUS_STYLES: Record<UserStatus, string> = {
  pending: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  active: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  disabled: 'border-slate-600 bg-slate-800 text-slate-400',
};

const ROLE_STYLES: Record<Role, string> = {
  admin: 'border-primary/40 bg-primary/10 text-primary',
  member: 'border-slate-600 bg-slate-800 text-slate-300',
};

/**
 * Settings → Members. Admin-only view that lists every account on the
 * deployment and lets the admin approve pending signups, toggle each
 * non-admin user's scopes, promote/demote, disable, or delete.
 *
 * Rendered inside the Settings page; the page itself is responsible
 * for not showing the Members tab to non-admins. This component
 * defends a second time: if a non-admin somehow lands here, it shows
 * an "Admins only" notice instead of fetching.
 */
export function MembersManager() {
  const { isAdmin, profile, profileLoading } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Member | null>(null);
  const [deleting, setDeleting] = useState<Member | null>(null);

  const ownProfileId = profile?.id;

  useEffect(() => {
    if (profileLoading) return;
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [isAdmin, profileLoading]);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/members');
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? 'Failed to load members');
      }
      const json = await res.json();
      setMembers(json.members ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load members');
    } finally {
      setLoading(false);
    }
  }

  async function patch(id: string, body: Partial<Pick<Member, 'role' | 'status' | 'scopes'>>) {
    const res = await fetch(`/api/admin/members/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(json?.error ?? 'Update failed');
    }
    return json.member as Member;
  }

  async function handleApprove(member: Member) {
    try {
      const updated = await patch(member.id, { status: 'active' });
      setMembers((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      toast.success(`Approved ${updated.full_name || updated.email}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Approve failed');
    }
  }

  async function handleStatusChange(member: Member, status: UserStatus) {
    try {
      const updated = await patch(member.id, { status });
      setMembers((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed');
    }
  }

  async function handleRoleChange(member: Member, role: Role) {
    try {
      const updated = await patch(member.id, { role });
      setMembers((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      toast.success(`Set ${updated.full_name || updated.email} as ${role}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed');
    }
  }

  async function handleDelete(member: Member) {
    try {
      const res = await fetch(`/api/admin/members/${member.id}`, { method: 'DELETE' });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? 'Delete failed');
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
      toast.success(`Removed ${member.full_name || member.email}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(null);
    }
  }

  if (profileLoading || loading) {
    return (
      <Card className="border-slate-800 bg-slate-900">
        <CardContent className="flex items-center justify-center py-12 text-slate-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading members…
        </CardContent>
      </Card>
    );
  }

  if (!isAdmin) {
    return (
      <Card className="border-slate-800 bg-slate-900">
        <CardContent className="flex items-center gap-3 py-8 text-slate-400">
          <ShieldAlert className="h-5 w-5 text-amber-300" />
          Only admins can manage members.
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="border-slate-800 bg-slate-900">
        <CardContent className="p-0">
          <ul className="divide-y divide-slate-800">
            {members.map((m) => {
              const isSelf = m.id === ownProfileId;
              return (
                <li key={m.id} className="flex flex-wrap items-center gap-4 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-white">
                        {m.full_name || '(no name)'}
                        {isSelf && (
                          <span className="ml-2 text-xs text-slate-500">(you)</span>
                        )}
                      </p>
                      <Badge variant="outline" className={ROLE_STYLES[m.role]}>
                        {m.role}
                      </Badge>
                      <Badge variant="outline" className={STATUS_STYLES[m.status]}>
                        {m.status}
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-slate-400">{m.email}</p>
                    {m.role === 'member' && m.scopes.length > 0 && (
                      <p className="mt-1 text-xs text-slate-500">
                        {m.scopes.length} scope{m.scopes.length === 1 ? '' : 's'} granted
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {m.status === 'pending' && (
                      <Button size="sm" onClick={() => handleApprove(m)}>
                        Approve
                      </Button>
                    )}
                    {m.status === 'active' && !isSelf && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-slate-700 text-slate-200"
                        onClick={() => handleStatusChange(m, 'disabled')}
                      >
                        Disable
                      </Button>
                    )}
                    {m.status === 'disabled' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-slate-700 text-slate-200"
                        onClick={() => handleStatusChange(m, 'active')}
                      >
                        Re-enable
                      </Button>
                    )}
                    {!isSelf && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-slate-700 text-slate-200"
                        onClick={() =>
                          handleRoleChange(m, m.role === 'admin' ? 'member' : 'admin')
                        }
                      >
                        Make {m.role === 'admin' ? 'member' : 'admin'}
                      </Button>
                    )}
                    {m.role === 'member' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-slate-700 text-slate-200"
                        onClick={() => setEditing(m)}
                      >
                        Edit scopes
                      </Button>
                    )}
                    {!isSelf && (
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Remove ${m.email}`}
                        className="border-red-500/40 text-red-300 hover:bg-red-500/10"
                        onClick={() => setDeleting(m)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <ScopeEditor
        member={editing}
        onClose={() => setEditing(null)}
        onSaved={(updated) => {
          setMembers((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
          setEditing(null);
        }}
      />

      <Dialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="border-slate-800 bg-slate-900 text-slate-100">
          <DialogHeader>
            <DialogTitle>Remove member?</DialogTitle>
            <DialogDescription className="text-slate-400">
              {deleting?.email} will be permanently deleted. Their owned rows
              (contacts, conversations, etc.) will be deleted by cascade. Prefer
              <span className="font-medium text-slate-200"> Disable </span>
              if you want to revoke access while preserving history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="border-slate-700 text-slate-200"
              onClick={() => setDeleting(null)}
            >
              Cancel
            </Button>
            <Button
              className="bg-red-500 text-white hover:bg-red-500/90"
              onClick={() => deleting && handleDelete(deleting)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ScopeEditor({
  member,
  onClose,
  onSaved,
}: {
  member: Member | null;
  onClose: () => void;
  onSaved: (m: Member) => void;
}) {
  const [draft, setDraft] = useState<Set<Scope>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (member) setDraft(new Set(member.scopes));
  }, [member]);

  const grouped = useMemo(() => {
    const groups: Record<string, Scope[]> = {};
    for (const s of ALL_SCOPES) {
      const [g] = s.split('.');
      (groups[g] ||= []).push(s);
    }
    return groups;
  }, []);

  if (!member) return null;

  const toggle = (s: Scope) => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/members/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scopes: Array.from(draft) }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? 'Save failed');
      toast.success('Scopes updated');
      onSaved(json.member);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!member} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto border-slate-800 bg-slate-900 text-slate-100 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Scopes for {member.full_name || member.email}</DialogTitle>
          <DialogDescription className="text-slate-400">
            Pick which modules this member can access. Admins always have every
            scope; this only applies to members.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {Object.entries(grouped).map(([group, scopes]) => (
            <div key={group}>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                {group}
              </p>
              <div className="flex flex-wrap gap-2">
                {scopes.map((s) => {
                  const enabled = draft.has(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => toggle(s)}
                      className={
                        enabled
                          ? 'rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs text-primary'
                          : 'rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800'
                      }
                    >
                      {s}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            className="border-slate-700 text-slate-200"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
