import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, RefreshCw, Shield, Trash2, UserCog, Mail, History, Key } from "lucide-react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";

const MODULES = [
  "dashboard", "placements", "attribution", "funnel", "countries", "creatives",
  "push", "automation", "scale_unlock", "migration", "rules", "integrations",
  "ai", "admins",
] as const;

type ModuleKey = typeof MODULES[number];

interface AdminUserRow {
  id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
  profile: { role: string; is_active: boolean; name: string | null; last_login_at: string | null } | null;
  permissions: Record<string, boolean> | null;
  site_access: Array<{ site_id: string }>;
  module_permissions: Array<{ module: string; can_access: boolean; can_edit: boolean }>;
  google_ads_permissions: Array<{ google_account_id: string; can_view: boolean; can_sync: boolean; can_migrate: boolean }>;
}

async function callAdmin(action: string, payload: Record<string, unknown> = {}) {
  const { data, error } = await supabase.functions.invoke("admin-users", {
    body: { action, ...payload },
  });
  if (error) throw new Error(error.message);
  if ((data as any)?.error) throw new Error((data as any).error);
  return data;
}

export default function AdminUsers() {
  const { data: role, isLoading: roleLoading } = useCurrentRole();
  const qc = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editUser, setEditUser] = useState<AdminUserRow | null>(null);

  const usersQuery = useQuery({
    queryKey: ["admin-users"],
    enabled: !!role?.isSuperAdmin,
    queryFn: async () => {
      const d = await callAdmin("list");
      return (d as any).users as AdminUserRow[];
    },
  });

  const sitesQuery = useQuery({
    queryKey: ["admin-sites"],
    enabled: !!role?.isSuperAdmin,
    queryFn: async () => {
      const { data } = await supabase.from("sites").select("id, name").order("name");
      return (data ?? []) as Array<{ id: string; name: string }>;
    },
  });

  const accountsQuery = useQuery({
    queryKey: ["admin-ga-accounts"],
    enabled: !!role?.isSuperAdmin,
    queryFn: async () => {
      const { data } = await supabase.from("google_accounts").select("id, account_name, descriptive_name, customer_id").order("account_name");
      return (data ?? []) as Array<{ id: string; account_name: string | null; descriptive_name: string | null; customer_id: string }>;
    },
  });

  const auditQuery = useQuery({
    queryKey: ["admin-audit"],
    enabled: !!role?.isSuperAdmin,
    queryFn: async () => {
      const { data } = await supabase.from("admin_audit_logs")
        .select("*").order("created_at", { ascending: false }).limit(100);
      return data ?? [];
    },
  });

  if (roleLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!role?.isSuperAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Shield className="h-5 w-5" /> Acesso restrito</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">Apenas super admins podem acessar esta página.</p>
            <Button asChild className="mt-4"><Link to="/">Voltar</Link></Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <UserCog className="h-7 w-7" /> Administração de Usuários
          </h1>
          <p className="text-muted-foreground">Gerencie quem acessa o sistema e o que cada um pode fazer.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild><Link to="/">Voltar</Link></Button>
          <Button variant="outline" size="icon" onClick={() => usersQuery.refetch()} disabled={usersQuery.isFetching}>
            <RefreshCw className={`h-4 w-4 ${usersQuery.isFetching ? "animate-spin" : ""}`} />
          </Button>
          <Button onClick={() => setInviteOpen(true)}><Plus className="h-4 w-4 mr-2" /> Convidar usuário</Button>
        </div>
      </div>

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">Usuários</TabsTrigger>
          <TabsTrigger value="audit"><History className="h-4 w-4 mr-2" /> Logs de acesso</TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="space-y-4">
          <Card>
            <CardContent className="p-0">
              {usersQuery.isLoading ? (
                <div className="p-8 flex justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>
              ) : usersQuery.error ? (
                <div className="p-8 text-destructive">{(usersQuery.error as Error).message}</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Nome</TableHead>
                      <TableHead>Papel</TableHead>
                      <TableHead>Sites</TableHead>
                      <TableHead>Contas Ads</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Último login</TableHead>
                      <TableHead>Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(usersQuery.data ?? []).map((u) => (
                      <TableRow key={u.id}>
                        <TableCell className="font-mono text-xs">{u.email}</TableCell>
                        <TableCell>{u.profile?.name ?? "—"}</TableCell>
                        <TableCell><RoleBadge role={u.profile?.role ?? "viewer"} /></TableCell>
                        <TableCell>{u.site_access.length}</TableCell>
                        <TableCell>{u.google_ads_permissions.length}</TableCell>
                        <TableCell>
                          {u.profile?.is_active ? (
                            <Badge variant="default" className="bg-green-600">Ativo</Badge>
                          ) : (
                            <Badge variant="secondary">Inativo</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString("pt-BR") : "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button size="sm" variant="outline" onClick={() => setEditUser(u)}>Editar</Button>
                            <Button size="sm" variant="ghost" onClick={async () => {
                              try { await callAdmin("reset_password", { email: u.email }); toast.success("Email de reset enviado"); }
                              catch (e) { toast.error((e as Error).message); }
                            }}><Mail className="h-4 w-4" /></Button>
                            <Button size="sm" variant="ghost" className="text-destructive" onClick={async () => {
                              if (!confirm(`Deletar ${u.email}? Esta ação é irreversível.`)) return;
                              try { await callAdmin("delete", { user_id: u.id }); toast.success("Usuário deletado"); qc.invalidateQueries({ queryKey: ["admin-users"] }); }
                              catch (e) { toast.error((e as Error).message); }
                            }}><Trash2 className="h-4 w-4" /></Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardHeader><CardTitle>Logs de acesso</CardTitle></CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[600px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Quando</TableHead>
                      <TableHead>Usuário</TableHead>
                      <TableHead>Ação</TableHead>
                      <TableHead>Recurso</TableHead>
                      <TableHead>Detalhes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(auditQuery.data ?? []).map((row: any) => (
                      <TableRow key={row.id}>
                        <TableCell className="text-xs whitespace-nowrap">{new Date(row.created_at).toLocaleString("pt-BR")}</TableCell>
                        <TableCell className="font-mono text-xs">{row.user_email ?? row.user_id.slice(0, 8)}</TableCell>
                        <TableCell><Badge variant="outline">{row.action}</Badge></TableCell>
                        <TableCell className="text-xs">{row.resource_type ?? row.resource_id?.slice(0, 8) ?? "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-md truncate">
                          {row.after ? JSON.stringify(row.after).slice(0, 120) : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} onDone={() => qc.invalidateQueries({ queryKey: ["admin-users"] })} />
      {editUser && (
        <EditDialog
          user={editUser}
          sites={sitesQuery.data ?? []}
          accounts={accountsQuery.data ?? []}
          onClose={() => setEditUser(null)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["admin-users"] }); setEditUser(null); }}
        />
      )}
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    super_admin: { label: "Super Admin", cls: "bg-purple-600 text-white" },
    admin: { label: "Admin", cls: "bg-blue-600 text-white" },
    manager: { label: "Manager", cls: "bg-amber-600 text-white" },
    viewer: { label: "Viewer", cls: "bg-slate-500 text-white" },
  };
  const m = map[role] ?? map.viewer;
  return <Badge className={m.cls}>{m.label}</Badge>;
}

function InviteDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("viewer");
  const [submitting, setSubmitting] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Convidar novo usuário</DialogTitle>
          <DialogDescription>O usuário recebe um email para definir a senha.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div><Label>Email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@empresa.com" /></div>
          <div><Label>Nome</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome completo" /></div>
          <div>
            <Label>Papel</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="super_admin">Super Admin</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="manager">Manager</SelectItem>
                <SelectItem value="viewer">Viewer</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button disabled={submitting || !email} onClick={async () => {
            setSubmitting(true);
            try {
              await callAdmin("invite", { email, name, role });
              toast.success("Convite enviado");
              setEmail(""); setName(""); setRole("viewer");
              onOpenChange(false); onDone();
            } catch (e) { toast.error((e as Error).message); }
            finally { setSubmitting(false); }
          }}>{submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Convidar"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({
  user, sites, accounts, onClose, onSaved,
}: {
  user: AdminUserRow;
  sites: Array<{ id: string; name: string }>;
  accounts: Array<{ id: string; account_name: string | null; descriptive_name: string | null; customer_id: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(user.profile?.name ?? "");
  const [role, setRole] = useState(user.profile?.role ?? "viewer");
  const [isActive, setIsActive] = useState(user.profile?.is_active ?? true);
  const [siteIds, setSiteIds] = useState<Set<string>>(new Set(user.site_access.map((s) => s.site_id)));
  const [modulePerms, setModulePerms] = useState<Record<string, { can_access: boolean; can_edit: boolean }>>(() => {
    const m: Record<string, { can_access: boolean; can_edit: boolean }> = {};
    for (const mod of MODULES) {
      const found = user.module_permissions.find((p) => p.module === mod);
      m[mod] = { can_access: found?.can_access ?? true, can_edit: found?.can_edit ?? false };
    }
    return m;
  });
  const [gaPerms, setGaPerms] = useState<Record<string, { can_view: boolean; can_sync: boolean; can_migrate: boolean }>>(() => {
    const m: Record<string, { can_view: boolean; can_sync: boolean; can_migrate: boolean }> = {};
    for (const a of accounts) {
      const found = user.google_ads_permissions.find((p) => p.google_account_id === a.id);
      m[a.id] = {
        can_view: found?.can_view ?? false,
        can_sync: found?.can_sync ?? false,
        can_migrate: found?.can_migrate ?? false,
      };
    }
    return m;
  });
  const [saving, setSaving] = useState(false);

  // Hidrata gaPerms quando accounts carrega
  useEffect(() => {
    setGaPerms((prev) => {
      const next = { ...prev };
      for (const a of accounts) {
        if (!next[a.id]) {
          const found = user.google_ads_permissions.find((p) => p.google_account_id === a.id);
          next[a.id] = {
            can_view: found?.can_view ?? false,
            can_sync: found?.can_sync ?? false,
            can_migrate: found?.can_migrate ?? false,
          };
        }
      }
      return next;
    });
  }, [accounts, user.google_ads_permissions]);

  const save = async () => {
    setSaving(true);
    try {
      await callAdmin("update_profile", { user_id: user.id, name, role, is_active: isActive });
      await callAdmin("set_site_access", { user_id: user.id, site_ids: Array.from(siteIds) });
      await callAdmin("set_module_perms", {
        user_id: user.id,
        permissions: MODULES.map((m) => ({ module: m, can_access: modulePerms[m].can_access, can_edit: modulePerms[m].can_edit })),
      });
      await callAdmin("set_ga_perms", {
        user_id: user.id,
        permissions: Object.entries(gaPerms)
          .filter(([_, p]) => p.can_view || p.can_sync || p.can_migrate)
          .map(([gid, p]) => ({ google_account_id: gid, ...p })),
      });
      toast.success("Permissões salvas");
      onSaved();
    } catch (e) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Editar {user.email}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="profile" className="flex-1 overflow-hidden flex flex-col">
          <TabsList>
            <TabsTrigger value="profile">Perfil</TabsTrigger>
            <TabsTrigger value="sites">Sites ({siteIds.size})</TabsTrigger>
            <TabsTrigger value="modules">Módulos</TabsTrigger>
            <TabsTrigger value="ads">Contas Ads</TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="space-y-3">
            <div><Label>Nome</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div>
              <Label>Papel</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="super_admin">Super Admin</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between border rounded p-3">
              <Label>Conta ativa</Label>
              <Switch checked={isActive} onCheckedChange={setIsActive} />
            </div>
          </TabsContent>

          <TabsContent value="sites" className="flex-1 overflow-hidden">
            <ScrollArea className="h-[400px] pr-3">
              <div className="space-y-2">
                {sites.map((s) => (
                  <div key={s.id} className="flex items-center justify-between border rounded p-3">
                    <div>
                      <div className="font-medium">{s.name}</div>
                      <div className="text-xs text-muted-foreground font-mono">{s.id.slice(0, 8)}</div>
                    </div>
                    <Switch
                      checked={siteIds.has(s.id)}
                      onCheckedChange={(v) => setSiteIds((prev) => {
                        const next = new Set(prev);
                        if (v) next.add(s.id); else next.delete(s.id);
                        return next;
                      })}
                    />
                  </div>
                ))}
                {sites.length === 0 && <p className="text-muted-foreground text-sm">Nenhum site cadastrado.</p>}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="modules" className="flex-1 overflow-hidden">
            <ScrollArea className="h-[400px] pr-3">
              <div className="space-y-2">
                {MODULES.map((m) => (
                  <div key={m} className="flex items-center justify-between border rounded p-3">
                    <div className="font-medium capitalize">{m.replace("_", " ")}</div>
                    <div className="flex items-center gap-4">
                      <div className="flex items-center gap-2">
                        <Label className="text-xs">Ver</Label>
                        <Switch checked={modulePerms[m].can_access}
                          onCheckedChange={(v) => setModulePerms((p) => ({ ...p, [m]: { ...p[m], can_access: v } }))} />
                      </div>
                      <div className="flex items-center gap-2">
                        <Label className="text-xs">Editar</Label>
                        <Switch checked={modulePerms[m].can_edit}
                          onCheckedChange={(v) => setModulePerms((p) => ({ ...p, [m]: { ...p[m], can_edit: v } }))} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="ads" className="flex-1 overflow-hidden">
            <ScrollArea className="h-[400px] pr-3">
              <div className="space-y-2">
                {accounts.map((a) => (
                  <div key={a.id} className="flex items-center justify-between border rounded p-3">
                    <div>
                      <div className="font-medium">{a.account_name ?? a.descriptive_name ?? a.customer_id}</div>
                      <div className="text-xs text-muted-foreground font-mono">{a.customer_id}</div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-1"><Label className="text-xs">Ver</Label>
                        <Switch checked={gaPerms[a.id]?.can_view ?? false}
                          onCheckedChange={(v) => setGaPerms((p) => ({ ...p, [a.id]: { ...(p[a.id] ?? { can_view: false, can_sync: false, can_migrate: false }), can_view: v } }))} /></div>
                      <div className="flex items-center gap-1"><Label className="text-xs">Sync</Label>
                        <Switch checked={gaPerms[a.id]?.can_sync ?? false}
                          onCheckedChange={(v) => setGaPerms((p) => ({ ...p, [a.id]: { ...(p[a.id] ?? { can_view: false, can_sync: false, can_migrate: false }), can_sync: v } }))} /></div>
                      <div className="flex items-center gap-1"><Label className="text-xs">Migrar</Label>
                        <Switch checked={gaPerms[a.id]?.can_migrate ?? false}
                          onCheckedChange={(v) => setGaPerms((p) => ({ ...p, [a.id]: { ...(p[a.id] ?? { can_view: false, can_sync: false, can_migrate: false }), can_migrate: v } }))} /></div>
                    </div>
                  </div>
                ))}
                {accounts.length === 0 && <p className="text-muted-foreground text-sm">Nenhuma conta Google Ads conectada.</p>}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={saving} onClick={save}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
