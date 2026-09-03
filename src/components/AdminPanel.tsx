import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp, store } from '../store';
import { useFocusTrap, useEscapeKey } from '../hooks';
import { t } from '../i18n';
import {
  CloseIcon,
  TrashIcon,
  BanIcon,
  SearchIcon,
  ShieldIcon,
} from './icons';

interface Report {
  id: number;
  reporter_id: number;
  reporter_username: string;
  reporter_name: string;
  target_type: string;
  target_id: number;
  reason: string;
  details: string | null;
  status: string;
  created_at: string;
}

interface BanEntry {
  user_id: number;
  username: string;
  first_name: string;
  last_name: string;
  reason: string | null;
  created_at: string;
}

interface AdminUser {
  id: number;
  username: string;
  first_name: string;
  last_name: string;
  phone: string;
  is_admin: number;
  created_at: string;
}

export function AdminPanel({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const me = app.me;
  const [tab, setTab] = useState<'reports' | 'users' | 'bans'>('reports');
  const [reports, setReports] = useState<Report[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [bans, setBans] = useState<BanEntry[]>([]);
  const [userQuery, setUserQuery] = useState('');
  const [reportFilter, setReportFilter] = useState<'pending' | 'reviewed' | 'dismissed'>('pending');
  const ref = useFocusTrap(true);
  useEscapeKey(onClose);

  const loadReports = () => api.getAdminReports(reportFilter).then(setReports).catch(() => {});
  const loadUsers = () => api.getAdminUsers(userQuery).then(setUsers).catch(() => {});
  const loadBans = () => api.getAdminBans().then(setBans).catch(() => {});

  useEffect(() => {
    if (tab === 'reports') loadReports();
    else if (tab === 'users') loadUsers();
    else loadBans();
  }, [tab, reportFilter, userQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!me?.is_admin) return null;

  const handleReview = async (id: number, status: 'reviewed' | 'dismissed') => {
    try { await api.reviewReport(id, status); } catch { /* ignore */ }
    setReports((prev) => prev.filter((r) => r.id !== id));
  };

  const handleBan = async (userId: number) => {
    const reason = prompt(t('Ban reason') + ':');
    if (reason === null) return;
    try { await api.adminBanUser(userId, reason); } catch { /* ignore */ }
    loadUsers();
  };

  const handleUnban = async (userId: number) => {
    try { await api.adminUnbanUser(userId); } catch { /* ignore */ }
    loadBans();
  };

  const handleDeleteMessages = async (userId: number) => {
    if (!confirm(t('Delete all messages from this user?'))) return;
    try { await api.adminDeleteUserMessages(userId); } catch { /* ignore */ }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t('Admin panel')}>
      <div className="modal admin-panel" ref={ref}>
        <div className="modal-header">
          <h2><ShieldIcon size={18} /> {t('Admin panel')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('Close')}><CloseIcon /></button>
        </div>

        <div className="admin-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'reports'} className={tab === 'reports' ? 'active' : ''} onClick={() => setTab('reports')}>
            {t('Reports')} ({reports.length})
          </button>
          <button role="tab" aria-selected={tab === 'users'} className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>
            {t('Users')}
          </button>
          <button role="tab" aria-selected={tab === 'bans'} className={tab === 'bans' ? 'active' : ''} onClick={() => setTab('bans')}>
            {t('Bans')}
          </button>
        </div>

        {tab === 'reports' && (
          <div className="admin-content" role="tabpanel">
            <div className="admin-filter">
              {(['pending', 'reviewed', 'dismissed'] as const).map((s) => (
                <button key={s} className={`filter-btn ${reportFilter === s ? 'active' : ''}`} onClick={() => setReportFilter(s)}>
                  {t(s.charAt(0).toUpperCase() + s.slice(1))}
                </button>
              ))}
            </div>
            {reports.length === 0 && <p className="empty-state">{t('No reports')}</p>}
            {reports.map((r) => (
              <div key={r.id} className="admin-report">
                <div className="report-header">
                  <span className="report-type">{t(r.target_type)}</span>
                  <span className="report-time">{new Date(r.created_at).toLocaleString()}</span>
                </div>
                <div className="report-reason"><b>{r.reason}</b>{r.details && ` — ${r.details}`}</div>
                <div className="report-reporter">{t('From')}: @{r.reporter_username} ({r.reporter_name})</div>
                <div className="report-actions">
                  <button className="btn-sm btn-ok" onClick={() => handleReview(r.id, 'reviewed')}>{t('Reviewed')}</button>
                  <button className="btn-sm btn-cancel" onClick={() => handleReview(r.id, 'dismissed')}>{t('Dismissed')}</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'users' && (
          <div className="admin-content" role="tabpanel">
            <div className="admin-search">
              <SearchIcon size={14} />
              <input
                type="text"
                placeholder={t('Search users…')}
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
              />
            </div>
            {users.map((u) => (
              <div key={u.id} className="admin-user">
                <div className="admin-user-info">
                  <b>{u.first_name} {u.last_name}</b>
                  <span className="dim">@{u.username}</span>
                  {u.is_admin ? <span className="badge admin">{t('Admin')}</span> : null}
                </div>
                <div className="admin-user-actions">
                  <button className="icon-btn danger" title={t('Ban')} onClick={() => handleBan(u.id)}><BanIcon size={14} /></button>
                  <button className="icon-btn danger" title={t('Delete messages')} onClick={() => handleDeleteMessages(u.id)}><TrashIcon size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'bans' && (
          <div className="admin-content" role="tabpanel">
            {bans.length === 0 && <p className="empty-state">{t('No bans')}</p>}
            {bans.map((b) => (
              <div key={b.user_id} className="admin-ban">
                <div className="ban-info">
                  <b>{b.first_name} {b.last_name}</b>
                  <span className="dim">@{b.username}</span>
                  {b.reason && <span className="ban-reason">— {b.reason}</span>}
                </div>
                <button className="btn-sm" onClick={() => handleUnban(b.user_id)}>{t('Unban')}</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
