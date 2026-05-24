import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowLeft, Shield, UserPlus, KeyRound, Trash2, Edit3, Lock, Unlock, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useAdminAcl, PERMISSION_KEYS, type AppRole, type PermissionKey } from "@/hooks/useAdminAcl";

const ROLE_OPTIONS: { value: AppRole; label: string }[] = [
  { value: "super_admin", label: "Super Admin" },
  { value: "admin", label: "Admin" },
  { value: "media_buyer", label: "Media Buyer" },
  { value: "adops", label: "AdOps" },
  { value: "site_manager", label: "Site Manager" },
  { value: "viewer", label: "Viewer" },
];

const PERM_LABELS: Record<PermissionKey, string> = {
  can_view_dashboard: "Ver Dashboard",
  can_sync: "Sincronizar contas",
  can_edit_rules: "Editar regras",
  can_run_automation: "Rodar automação",
  can_pause_campaigns: "Pausar campanhas",
  can_scale_campaigns: "Escalar campanhas",
  can_view_revenue: "Ver receita",
  can_view_profit: "Ver lucro",
  can_manage_push: "Gerenciar Push",
  can_manage_users: "Gerenciar usuários",
  can_use_migration: "Usar Migração",
  can_use_funil: "Usar Funil",
  can_use_geo_expansion: "Usar Geo / Expansão",
  can_use_placements_cleanup: "Limpeza de Placements",
  can_edit_budgets: "Editar orçamentos",
  can_edit_cpa: "Editar CPA",
  can_view_logs: "Ver logs",
};

type AdminUser = {
  user_id: string;
  email: string | null;
  name: string | null;
  role: AppRole;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  permissions: Record<PermissionKey, boolean> | null;
  site_ids: string[];
};

function emptyPerms(): Record<PermissionKey, boolean> {
  return PERMISSION_KEYS.reduce((a, k) => ({ ...a, [k]: false }), {} as Record<PermissionKey, boolean>);
}

export default function AdminsPage() {
  const acl = useAdminAcl();
  const qc = useQueryClient();
  const allowed = acl.isSuperAdmin || acl.can("can_manage_users");

  const usersQ = useQuery({
    queryKey: ["admin-users"],
    enabled: allowed,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("admin-users-manage", { body: { action: "list" } });
      if (error) throw error;
      return (data?.users ?? []) as AdminUser[];
    },
  });

  const sitesQ = useQuery({
    queryKey: ["admin-users-sites"],
    enabled: allowed,
    queryFn: async () => {
      const { data } = await supabase.from("sites").select("id,name,domain").order("name");
      return data ?? [];
    },
  });

  const siteNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sitesQ.data ?? []) m.set(s.id, s.name ?? s.domain);
    return m;
  }, [sitesQ.data]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin-users"] });

  const callFn = async (body: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke("admin-users-manage", { body });
    if (error || data?.error) throw new Error(data?.error ?? error?.message ?? "Erro");
    return data;
  };

  const createMut = useMutation({
    mutationFn: (payload: Record<string, unknown>) => callFn({ action: "create", ...payload }),
    onSuccess: () => { toast({ title: "Usuário criado" }); invalidate(); },
    onError: (e: Error) => toast({ title: "Falha ao criar", description: e.message, variant: "destructive" }),
  });

  const updateMut = useMutation({
    mutationFn: (payload: Record<string, unknown>) => callFn({ action: "update", ...payload }),
    onSuccess: () => { toast({ title: "Atualizado" }); invalidate(); },
    onError: (e: Error) => toast({ title: "Falha", description: e.message, variant: "destructive" }),
  });

  const permsMut = useMutation({
    mutationFn: (payload: Record<string, unknown>) => callFn({ action: "set_permissions", ...payload }),
    onSuccess: () => { toast({ title: "Permissões salvas" }); invalidate(); },
    onError: (e: Error) => toast({ title: "Falha", description: e.message, variant: "destructive" }),
  });

  const sitesMut = useMutation({
    mutationFn: (payload: Record<string, unknown>) => callFn({ action: "set_site_access", ...payload }),
    onSuccess: () => { toast({ title: "Sites atualizados" }); invalidate(); },
    onError: (e: Error) => toast({ title: "Falha", description: e.message, variant: "destructive" }),
  });

  const resetMut = useMutation({
    mutationFn: (email: string) => callFn({ action: "reset_password", email, redirect_to: `${window.location.origin}/auth` }),
    onSuccess: () => toast({ title: "Email de reset enviado" }),
    onError: (e: Error) => toast({ title: "Falha", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (user_id: string) => callFn({ action: "delete", user_id }),
    onSuccess: () => { toast({ title: "Usuário removido" }); invalidate(); },
    onError: (e: Error) => toast({ title: "Falha", description: e.message, variant: "destructive" }),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);

  if (acl.loading) return <div className="p-8 text-muted-foreground">Carregando…</div>;
  if (!allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Lock className="h-5 w-5" /> Acesso negado</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">Você não tem permissão para gerenciar usuários.</p>
            <Button asChild variant="outline" size="sm"><Link to="/">Voltar</Link></Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const users = usersQ.data ?? [];
  const stats = {
    total: users.length,
    active: users.filter((u) => u.is_active).length,
    super: users.filter((u) => u.role === "super_admin").length,
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/60 backdrop-blur-sm sticky top-0 z-10">
        <div className="container py-4 flex items-center gap-4">
          <Button asChild variant="ghost" size="sm" className="gap-2">
            <Link to="/"><ArrowLeft className="h-4 w-4" /> Dashboard</Link>
          </Button>
          <div className="h-9 w-9 rounded-lg bg-gradient-primary flex items-center justify-center shadow-glow">
            <Shield className="h-4 w-4 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">Admins / Controle de Acesso</h1>
            <p className="text-xs text-muted-foreground">Usuários, permissões granulares e auditoria</p>
          </div>
          <div className="ml-auto">
            <Button size="sm" className="gap-2" onClick={() => setCreateOpen(true)}>
              <UserPlus className="h-4 w-4" /> Novo usuário
            </Button>
          </div>
        </div>
      </header>

      <main className="container py-6 space-y-6">
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard label="Total de usuários" value={stats.total} />
          <StatCard label="Ativos" value={stats.active} />
          <StatCard label="Super admins" value={stats.super} />
        </section>

        <Tabs defaultValue="users">
          <TabsList>
            <TabsTrigger value="users">Usuários</TabsTrigger>
            <TabsTrigger value="audit"><History className="h-3.5 w-3.5 mr-1" /> Auditoria</TabsTrigger>
          </TabsList>

          <TabsContent value="users" className="mt-6">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nome</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Sites permitidos</TableHead>
                      <TableHead>Último login</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {usersQ.isLoading && (
                      <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">Carregando…</TableCell></TableRow>
                    )}
                    {!usersQ.isLoading && users.length === 0 && (
                      <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">Nenhum usuário</TableCell></TableRow>
                    )}
                    {users.map((u) => (
                      <TableRow key={u.user_id}>
                        <TableCell className="font-medium">{u.name ?? "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{u.email ?? "—"}</TableCell>
                        <TableCell><Badge variant={u.role === "super_admin" ? "default" : "secondary"}>{u.role}</Badge></TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1 max-w-xs">
                            {u.role === "super_admin" ? (
                              <Badge variant="outline">todos</Badge>
                            ) : u.site_ids.length === 0 ? (
                              <span className="text-xs text-muted-foreground">nenhum</span>
                            ) : (
                              u.site_ids.slice(0, 4).map((sid) => (
                                <Badge key={sid} variant="outline" className="text-xs">{siteNameById.get(sid) ?? sid.slice(0, 6)}</Badge>
                              ))
                            )}
                            {u.site_ids.length > 4 && <Badge variant="outline" className="text-xs">+{u.site_ids.length - 4}</Badge>}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {u.last_login_at ? new Date(u.last_login_at).toLocaleString("pt-BR") : "—"}
                        </TableCell>
                        <TableCell>
                          {u.is_active
                            ? <Badge variant="default" className="bg-emerald-600">ativo</Badge>
                            : <Badge variant="destructive">bloqueado</Badge>}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="icon" variant="ghost" title="Editar" onClick={() => setEditUser(u)}>
                              <Edit3 className="h-4 w-4" />
                            </Button>
                            <Button size="icon" variant="ghost" title={u.is_active ? "Bloquear" : "Desbloquear"}
                              onClick={() => updateMut.mutate({ user_id: u.user_id, is_active: !u.is_active })}>
                              {u.is_active ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                            </Button>
                            <Button size="icon" variant="ghost" title="Resetar senha"
                              onClick={() => u.email && resetMut.mutate(u.email)} disabled={!u.email}>
                              <KeyRound className="h-4 w-4" />
                            </Button>
                            <Button size="icon" variant="ghost" title="Excluir" className="text-destructive"
                              onClick={() => {
                                if (confirm(`Excluir usuário ${u.email}? Esta ação é definitiva.`)) deleteMut.mutate(u.user_id);
                              }}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="audit" className="mt-6">
            <AuditLogTab />
          </TabsContent>
        </Tabs>
      </main>

      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        sites={sitesQ.data ?? []}
        onSubmit={async (payload) => {
          await createMut.mutateAsync(payload);
          setCreateOpen(false);
        }}
      />

      {editUser && (
        <EditUserDialog
          user={editUser}
          sites={sitesQ.data ?? []}
          onClose={() => setEditUser(null)}
          onSaveProfile={(p) => updateMut.mutateAsync({ user_id: editUser.user_id, ...p })}
          onSavePerms={(perms) => permsMut.mutateAsync({ user_id: editUser.user_id, permissions: perms })}
          onSaveSites={(site_ids) => sitesMut.mutateAsync({ user_id: editUser.user_id, site_ids })}
        />
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="text-3xl font-bold mt-1">{value}</div>
      </CardContent>
    </Card>
  );
}

function CreateUserDialog({
  open, onOpenChange, sites, onSubmit,
}: {
  open: boolean;
  onOpenChange: (b: boolean) => void;
  sites: { id: string; name: string | null; domain: string }[];
  onSubmit: (p: Record<string, unknown>) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<AppRole>("viewer");
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [perms, setPerms] = useState<Record<PermissionKey, boolean>>(emptyPerms);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit({ email, password, name, role, site_ids: siteIds, permissions: perms });
      setEmail(""); setPassword(""); setName(""); setRole("viewer"); setSiteIds([]); setPerms(emptyPerms());
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Novo usuário</DialogTitle>
          <DialogDescription>Crie uma conta com permissões granulares e acesso a sites específicos.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Nome</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div>
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as AppRole)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label>Email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div><Label>Senha</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          </div>

          <SitesPicker sites={sites} value={siteIds} onChange={setSiteIds} />
          <PermissionsPicker value={perms} onChange={setPerms} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={submit} disabled={busy || !email || !password}>Criar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog({
  user, sites, onClose, onSaveProfile, onSavePerms, onSaveSites,
}: {
  user: AdminUser;
  sites: { id: string; name: string | null; domain: string }[];
  onClose: () => void;
  onSaveProfile: (p: { name?: string; role?: AppRole }) => Promise<unknown>;
  onSavePerms: (p: Record<PermissionKey, boolean>) => Promise<unknown>;
  onSaveSites: (ids: string[]) => Promise<unknown>;
}) {
  const [name, setName] = useState(user.name ?? "");
  const [role, setRole] = useState<AppRole>(user.role);
  const [siteIds, setSiteIds] = useState<string[]>(user.site_ids);
  const [perms, setPerms] = useState<Record<PermissionKey, boolean>>(
    { ...emptyPerms(), ...(user.permissions ?? {}) },
  );
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await Promise.all([
        onSaveProfile({ name, role }),
        onSavePerms(perms),
        onSaveSites(siteIds),
      ]);
      onClose();
    } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Editar {user.email}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Nome</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div>
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as AppRole)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <SitesPicker sites={sites} value={siteIds} onChange={setSiteIds} />
          <PermissionsPicker value={perms} onChange={setPerms} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={save} disabled={busy}>Salvar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SitesPicker({
  sites, value, onChange,
}: {
  sites: { id: string; name: string | null; domain: string }[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  };
  return (
    <div className="space-y-2">
      <Label>Sites permitidos ({value.length})</Label>
      <div className="rounded-md border border-border p-3 max-h-40 overflow-y-auto grid grid-cols-2 gap-2">
        {sites.length === 0 && <div className="text-xs text-muted-foreground col-span-2">Nenhum site cadastrado</div>}
        {sites.map((s) => (
          <label key={s.id} className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox checked={value.includes(s.id)} onCheckedChange={() => toggle(s.id)} />
            <span>{s.name ?? s.domain}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function PermissionsPicker({
  value, onChange,
}: {
  value: Record<PermissionKey, boolean>;
  onChange: (v: Record<PermissionKey, boolean>) => void;
}) {
  const toggle = (k: PermissionKey) => onChange({ ...value, [k]: !value[k] });
  return (
    <div className="space-y-2">
      <Label>Permissões</Label>
      <div className="rounded-md border border-border p-3 grid grid-cols-2 gap-2 max-h-72 overflow-y-auto">
        {PERMISSION_KEYS.map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox checked={!!value[k]} onCheckedChange={() => toggle(k)} />
            <span>{PERM_LABELS[k]}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function AuditLogTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["admin-audit"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("admin-users-manage", {
        body: { action: "list_audit", limit: 300 },
      });
      if (error) throw error;
      return data?.logs ?? [];
    },
  });
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Quando</TableHead>
              <TableHead>Usuário</TableHead>
              <TableHead>Ação</TableHead>
              <TableHead>Recurso</TableHead>
              <TableHead>Detalhes</TableHead>
              <TableHead>IP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Carregando…</TableCell></TableRow>}
            {!isLoading && (data?.length ?? 0) === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Sem registros</TableCell></TableRow>}
            {(data ?? []).map((row: Record<string, any>) => (
              <TableRow key={row.id}>
                <TableCell className="text-xs whitespace-nowrap">{new Date(row.created_at).toLocaleString("pt-BR")}</TableCell>
                <TableCell className="text-xs font-mono">{row.user_email ?? row.user_id?.slice(0, 8)}</TableCell>
                <TableCell><Badge variant="outline">{row.action}</Badge></TableCell>
                <TableCell className="text-xs">{row.resource_type ?? "—"} {row.resource_id ? `· ${String(row.resource_id).slice(0, 12)}` : ""}</TableCell>
                <TableCell className="text-xs font-mono max-w-md truncate">
                  {row.after ? JSON.stringify(row.after) : row.before ? JSON.stringify(row.before) : ""}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{row.ip ?? ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
