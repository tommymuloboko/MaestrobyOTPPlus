import { Fragment, useState } from 'react';
import { api, type AppUserView, type Session } from './api';
import ExportMenu from './ExportMenu';
import type { ExportSpec } from './exporter';
import { FilterBar, OneTimeBox, lower, matches } from './OmcShared';
import { Field, Notice, Rows, Select, StatusChip, useAction, useLoad } from './ui';

const CUSTOMER_ROLE = 'Fleet Manager';
const PLATFORM_ADMIN = 'Platform Admin';
const BASE_ROLES = [CUSTOMER_ROLE, 'Station Manager', 'Attendant', 'Finance', 'OMC Administrator'];

type StatusFilter = 'ALL' | 'ACTIVE' | 'INACTIVE';
const FILTERS: [StatusFilter, string][] = [['ALL', 'All'], ['ACTIVE', 'Active'], ['INACTIVE', 'Inactive']];

interface Draft { name: string; role: string; organization: string; branchCode: string }

function UserForm({ draft, onChange, roles, customers, roleLocked }: {
  draft: Draft; onChange: (d: Draft) => void; roles: string[]; customers: string[]; roleLocked?: boolean;
}) {
  const set = (k: keyof Draft) => (v: string) => onChange({ ...draft, [k]: v });
  const fleet = draft.role === CUSTOMER_ROLE;
  return (
    <>
      <Field label="Full name" value={draft.name} onChange={set('name')} required />
      <div className="row2">
        <label>Role
          <select value={draft.role} disabled={roleLocked} onChange={(e) => onChange({ ...draft, role: e.target.value })}>
            {roles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        {fleet
          ? <Select label="Customer" value={draft.organization} onChange={set('organization')} options={['', ...customers].map((c): [string, string] => [c, c || 'Choose a customer…'])} />
          : <label>Organization<input value="Set automatically from the role" disabled readOnly /></label>}
      </div>
      {fleet && <Field label="Branch code (optional)" value={draft.branchCode} onChange={set('branchCode')} placeholder="e.g. JHB" />}
    </>
  );
}

export default function UsersAdmin({ me }: { me: Session }) {
  const users = useLoad(api.users);
  const orgs = useLoad(api.organizations);
  const act = useAction();
  const isPlatformAdmin = me.role === PLATFORM_ADMIN;
  const roles = isPlatformAdmin ? [...BASE_ROLES, PLATFORM_ADMIN] : BASE_ROLES;
  const customers = (orgs.data ?? []).filter((o) => o.type === 'CUSTOMER').map((o) => o.name);

  const [filter, setFilter] = useState<StatusFilter>('ALL');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState('');
  const [deleting, setDeleting] = useState('');
  const [draft, setDraft] = useState<Draft>({ name: '', role: 'Attendant', organization: '', branchCode: '' });
  const [email, setEmail] = useState('');
  const [issued, setIssued] = useState<{ title: string; email: string; password: string } | null>(null);
  const [form, setForm] = useState<Draft>({ name: '', role: 'Attendant', organization: '', branchCode: '' });

  const all = users.data ?? [];
  const shown = all.filter((u) => (filter === 'ALL' || (filter === 'ACTIVE' ? u.active : !u.active))
    && matches(query, u.name, u.email, u.role, u.organization));
  const isSelf = (u: AppUserView) => u.email.toLowerCase() === me.email.toLowerCase();
  // an OMC Administrator is not the platform operator, so Platform Admin accounts are read-only to them
  const locked = (u: AppUserView) => u.role === PLATFORM_ADMIN && !isPlatformAdmin;

  const payload = (d: Draft) => ({
    name: d.name.trim(), role: d.role,
    ...(d.role === CUSTOMER_ROLE ? { organization: d.organization, branchCode: d.branchCode.trim() || undefined } : {}),
  });

  const add = () => act.run(async () => {
    setIssued(null);
    const result = await api.addUser({ email: email.trim(), ...payload(form) });
    setIssued({ title: `${result.user.name} added`, email: result.loginEmail, password: result.temporaryPassword });
    setEmail('');
    setForm({ ...form, name: '', branchCode: '' });
    await users.reload();
  });

  const startEdit = (u: AppUserView) => {
    setDeleting('');
    setEditing(editing === u.id ? '' : u.id);
    setDraft({ name: u.name, role: u.role, organization: u.organization, branchCode: u.branchCode ?? '' });
  };
  const save = (u: AppUserView) => act.run(async () => {
    await api.updateUser(u.id, payload(draft));
    setEditing('');
    await users.reload();
    return draft.role !== u.role ? `${draft.name} updated. They will need to sign in again.` : `${draft.name} updated.`;
  });
  const toggleActive = (u: AppUserView) => act.run(async () => {
    await api.setUserActive(u.id, !u.active);
    await users.reload();
    return u.active ? `${u.name} deactivated and signed out.` : `${u.name} reactivated.`;
  });
  const resetPassword = (u: AppUserView) => act.run(async () => {
    setIssued(null);
    const r = await api.resetUserPassword(u.id);
    setIssued({ title: `New password for ${u.name}`, email: r.loginEmail, password: r.temporaryPassword });
    await users.reload();
  });
  const remove = (u: AppUserView) => act.run(async () => {
    await api.deleteUser(u.id);
    setDeleting('');
    setEditing('');
    await users.reload();
    return `${u.name} deleted.`;
  });

  const exportSpec = (): ExportSpec => ({
    title: 'Users',
    subtitle: `${shown.length} of ${all.length} accounts (passwords are never exported)`,
    filename: 'users',
    columns: [{ header: 'Name' }, { header: 'Email' }, { header: 'Role' }, { header: 'Organization' }, { header: 'Branch' }, { header: 'Status' }],
    rows: shown.map((u) => [u.name, u.email, u.role, u.organization, u.branchCode, u.active ? 'Active' : 'Inactive']),
  });

  return (
    <>
      <Notice error={act.error || users.error} ok={act.ok} />
      {issued && (
        <OneTimeBox title={issued.title} secretLabel="Temporary password" secret={issued.password}
          note={`Login: ${issued.email}. Hand these to the user now.`} onDismiss={() => setIssued(null)} />
      )}
      <div className="row-2" style={{ marginTop: 0, gridTemplateColumns: 'minmax(0, 1.9fr) minmax(0, 1fr)', alignItems: 'start' }}>
        <section className="card">
          <div className="card-head">
            <h2>User accounts</h2>
            <div className="head-tools"><small className="muted">{all.length} accounts</small><ExportMenu build={exportSpec} disabled={shown.length === 0} /></div>
          </div>
          <FilterBar options={FILTERS} value={filter} onChange={setFilter}
            count={(k) => all.filter((u) => k === 'ALL' || (k === 'ACTIVE' ? u.active : !u.active)).length}
            query={query} onQuery={setQuery} placeholder="Name, email, role…" />
          <div className="tbl-scroll">
            <table>
              <thead><tr><th>User</th><th>Role</th><th>Organization</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                <Rows state={{ ...users, data: users.data ? shown : null }} cols={5} empty="No users match.">
                  {(rows) => rows.map((u) => (
                    <Fragment key={u.id}>
                      <tr className={editing === u.id ? 'picked' : undefined}>
                        <td><b>{u.name}</b>{isSelf(u) && <> <span className="chip chip-active">you</span></>}<br /><small>{u.email}</small></td>
                        <td>{u.role}</td>
                        <td>{u.organization}{u.branchCode && <><br /><small>branch {u.branchCode}</small></>}</td>
                        <td><StatusChip status={u.active ? 'active' : 'inactive'} /></td>
                        <td>
                          {locked(u)
                            ? <small className="muted">Only a Platform Admin can change this account</small>
                            : (
                              <div className="inline-actions row-actions">
                                <button className="mini-btn" disabled={act.busy} onClick={() => startEdit(u)}>{editing === u.id ? 'Close' : 'Edit'}</button>
                                <button className="mini-btn" disabled={act.busy || isSelf(u)} title={isSelf(u) ? 'You cannot reset your own password here' : undefined}
                                  onClick={() => void resetPassword(u)}>Reset password</button>
                                <button className="mini-btn" disabled={act.busy || isSelf(u)} title={isSelf(u) ? 'You cannot deactivate yourself' : undefined}
                                  onClick={() => void toggleActive(u)}>{u.active ? 'Deactivate' : 'Reactivate'}</button>
                                <button className="btn-ghost" disabled={act.busy || isSelf(u)} title={isSelf(u) ? 'You cannot delete yourself' : undefined}
                                  onClick={() => { setEditing(''); setDeleting(deleting === u.id ? '' : u.id); }}>Delete</button>
                              </div>
                            )}
                        </td>
                      </tr>
                      {editing === u.id && (
                        <tr><td colSpan={5}>
                          <form onSubmit={(e) => { e.preventDefault(); void save(u); }}>
                            <UserForm draft={draft} onChange={setDraft} roles={roles} customers={customers} roleLocked={isSelf(u)} />
                            {isSelf(u) && <small className="muted">You cannot change your own role.</small>}
                            <div className="inline-actions">
                              <button type="submit" className="btn-ok" disabled={act.busy || !draft.name.trim() || (draft.role === CUSTOMER_ROLE && !draft.organization)}>Save changes</button>
                              <button type="button" className="mini-btn" onClick={() => setEditing('')}>Cancel</button>
                            </div>
                            <small className="muted">The email address is the login and cannot be changed. A changed role or customer signs the person out.</small>
                          </form>
                        </td></tr>
                      )}
                      {deleting === u.id && (
                        <tr><td colSpan={5}>
                          <div className="select-confirm">
                            Permanently delete <b>{u.name}</b> ({u.email})? They are signed out at once and the account cannot be recovered.
                            {' '}Deactivating keeps the account.
                            <button type="button" className="btn-ghost" disabled={act.busy} onClick={() => void remove(u)}>Delete user</button>
                            <button type="button" className="mini-btn" onClick={() => setDeleting('')}>Back</button>
                          </div>
                        </td></tr>
                      )}
                    </Fragment>
                  ))}
                </Rows>
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2>Add user</h2><small className="muted">Creates a login with a temporary password</small></div>
          <form onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <Field label="Email (the login)" type="email" value={email} onChange={setEmail} required />
            <UserForm draft={form} onChange={setForm} roles={roles} customers={customers} />
            <button type="submit" className="cta green wide"
              disabled={act.busy || !email.trim() || !form.name.trim() || (form.role === CUSTOMER_ROLE && !form.organization)}>
              {act.busy ? 'Working…' : 'Add user'}
            </button>
          </form>
          <small className="muted">
            {lower(form.role) === 'fleet manager'
              ? 'A fleet manager belongs to one customer and only sees that customer’s data.'
              : 'Staff belong to the supplier and get the permissions of their role.'}
          </small>
        </section>
      </div>
    </>
  );
}
