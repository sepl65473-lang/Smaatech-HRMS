import { useEffect, useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import ConfirmDialog from '../components/ConfirmDialog';
import UserForm from '../components/UserForm';
import FaceEnrollModal from '../components/FaceEnrollModal';
import { IconPlus, IconX, IconEdit, IconTrash } from '../components/Icons';
import { ROLE_SCOPE } from '../lib/permissions';

function Toggle({ on, onClick }) {
  return <button className={`toggle ${on ? 'on' : ''}`} onClick={onClick} aria-pressed={on} />;
}

const CHANNELS = ['In-app', 'Email', 'WhatsApp', 'SMS'];
const LIVE_CHANNELS = ['In-app', 'Email'];

function ChannelRow({ label, sub, selected, onToggle }) {
  return (
    <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
      <div>
        <div className="settings-row-label">{label}</div>
        <div className="settings-row-sub">{sub}</div>
      </div>
      <div className="filter-chips">
        {CHANNELS.map((ch) => {
          const live = LIVE_CHANNELS.includes(ch);
          return (
            <button
              key={ch}
              className={`chip ${selected.includes(ch) ? 'active' : ''}`}
              disabled={!live}
              title={live ? undefined : 'Not connected yet — needs a WhatsApp/SMS provider set up first'}
              style={live ? undefined : { opacity: 0.45, cursor: 'not-allowed' }}
              onClick={() => live && onToggle(ch)}
            >
              {ch}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChipManager({ label, sub, items, onAdd, onRemove, placeholder }) {
  const [value, setValue] = useState('');
  const submit = () => {
    const v = value.trim();
    if (!v || items.includes(v)) return;
    onAdd(v);
    setValue('');
  };
  return (
    <div className="card">
      <div className="card-head">
        <div><div className="card-title">{label}</div><div className="card-sub">{sub}</div></div>
      </div>
      <div className="filter-chips">
        {items.length === 0 && <div className="empty">None added yet.</div>}
        {items.map((item) => (
          <span key={item} className="chip active" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {item}
            <button
              className="icon-btn sm"
              title={`Remove ${item}`}
              onClick={() => onRemove(item)}
            >
              <IconX width="14" height="14" />
            </button>
          </span>
        ))}
      </div>
      <div className="form-grid" style={{ marginTop: 12 }}>
        <label className="field field-full" style={{ flexDirection: 'row', gap: 8, minWidth: 0 }}>
          <input
            className="input"
            style={{ minWidth: 0 }}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder={placeholder}
          />
          <button className="btn" style={{ flexShrink: 0 }} onClick={submit}><IconPlus width="14" height="14" /> Add</button>
        </label>
      </div>
    </div>
  );
}

export default function Settings() {
  const {
    settings, employees, currentUser, updateSettings, toggleSetting, resetDatabase, toast, enrollFace,
    users, loadUsers, addUserAccount, updateUserAccount, deleteUserAccount,
    masterCategories, masterValues, addMasterValue, deleteMasterValue,
    loadSessions, revokeSession, revokeOtherSessions, searchAuditLog,
  } = useHRMS();
  const [orgName, setOrgName] = useState('');
  const [workWeek, setWorkWeek] = useState('5-day');
  const [totalLeaveDays, setTotalLeaveDays] = useState(24);
  const [confirmReset, setConfirmReset] = useState(false);
  const [userFormOpen, setUserFormOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [confirmRemoveUser, setConfirmRemoveUser] = useState(null);
  const [faceEnrollUser, setFaceEnrollUser] = useState(null);
  const [sessions, setSessions] = useState([]);
  const AUDIT_PAGE_SIZE = 10;
  const [auditPage, setAuditPage] = useState(1);
  const [auditRows, setAuditRows] = useState([]);
  const [auditTotal, setAuditTotal] = useState(0);

  // Notification Template states
  const [templateChannel, setTemplateChannel] = useState('email');
  const [templateName, setTemplateName] = useState('leaveApproval');
  const [templateText, setTemplateText] = useState('');

  useEffect(() => {
    if (settings.notificationTemplates) {
      setTemplateText(settings.notificationTemplates[templateChannel]?.[templateName] || '');
    }
  }, [settings.notificationTemplates, templateChannel, templateName]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  useEffect(() => {
    searchAuditLog({ page: auditPage, limit: AUDIT_PAGE_SIZE })
      .then((data) => { setAuditRows(data.rows); setAuditTotal(data.total); })
      .catch(() => {});
  }, [auditPage, searchAuditLog]);

  const refreshSessions = () => { loadSessions().then(setSessions).catch(() => {}); };
  useEffect(() => { refreshSessions(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRevokeSession = async (id) => {
    await revokeSession(id);
    refreshSessions();
  };
  const handleRevokeOthers = async () => {
    await revokeOtherSessions();
    refreshSessions();
  };

  const designations = settings.designations || [];

  const deptCategory = masterCategories.find((c) => c.code === 'departments');
  const locCategory = masterCategories.find((c) => c.code === 'locations');
  const deptValues = masterValues.filter((v) => v.categoryId === deptCategory?.id && v.active !== false);
  const locValues = masterValues.filter((v) => v.categoryId === locCategory?.id && v.active !== false);

  const notifyChannels = settings.notifyChannels || { leave: ['In-app'], payroll: ['In-app'], birthday: ['In-app'] };
  const toggleChannel = (category, channel) => {
    const current = notifyChannels[category] || [];
    const next = current.includes(channel) ? current.filter((c) => c !== channel) : [...current, channel];
    updateSettings({ notifyChannels: { ...notifyChannels, [category]: next } }, false);
  };

  const addDesignation = (d) => updateSettings({ designations: [...designations, d] }, false);
  const removeDesignation = (d) => updateSettings({ designations: designations.filter((x) => x !== d) }, false);

  const openAddUser = () => { setEditingUser(null); setUserFormOpen(true); };
  const openEditUser = (u) => { setEditingUser(u); setUserFormOpen(true); };
  const saveUser = async (user) => {
    try {
      if (editingUser) await updateUserAccount(editingUser.id, user);
      else await addUserAccount(user);
      setUserFormOpen(false);
    } catch {
      // addUserAccount/updateUserAccount already surfaced a toast; keep the
      // modal open so the HR Director can fix the input (e.g. duplicate email).
    }
  };
  const removeUser = async (id) => {
    await deleteUserAccount(id);
    setConfirmRemoveUser(null);
  };

  const saveFaceDescriptor = async (photoBlob) => {
    await enrollFace(photoBlob, faceEnrollUser.email);
    setFaceEnrollUser(null);
  };

  const [gpsCheckInEnabled, setGpsCheckInEnabled] = useState(false);
  const [geofenceLat, setGeofenceLat] = useState(19.0760);
  const [geofenceLng, setGeofenceLng] = useState(72.8777);
  const [geofenceRadius, setGeofenceRadius] = useState(25);

  const [twilioSid, setTwilioSid] = useState('');
  const [twilioToken, setTwilioToken] = useState('');
  const [twilioFrom, setTwilioFrom] = useState('');
  const [sendgridKey, setSendgridKey] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');

  const fetchCurrentLocation = () => {
    if (!navigator.geolocation) {
      toast('error', 'Geolocation is not supported by your browser');
      return;
    }
    toast('info', 'Retrieving device GPS coordinates...');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGeofenceLat(position.coords.latitude);
        setGeofenceLng(position.coords.longitude);
        toast('success', 'GPS Coordinates loaded successfully!');
      },
      (error) => {
        toast('error', `Failed to get location: ${error.message}`);
      }
    );
  };

  useEffect(() => {
    setOrgName(settings.orgName || '');
    setWorkWeek(settings.workWeek || '5-day');
    setTotalLeaveDays(Number(settings.totalLeaveDays || 24));
    setGpsCheckInEnabled(settings.gpsCheckInEnabled ?? false);
    setGeofenceLat(settings.geofenceLat ?? 19.0760);
    setGeofenceLng(settings.geofenceLng ?? 72.8777);
    setGeofenceRadius(settings.geofenceRadius ?? 25);
    setTwilioSid(settings.gatewayTwilioSid || '');
    setTwilioToken(settings.gatewayTwilioToken || '');
    setTwilioFrom(settings.gatewayTwilioFrom || '');
    setSendgridKey(settings.gatewaySendgridKey || '');
    setSmtpHost(settings.gatewaySmtpHost || '');
    setSmtpUser(settings.gatewaySmtpUser || '');
    setSmtpPass(settings.gatewaySmtpPass || '');
  }, [
    settings.orgName, settings.workWeek, settings.totalLeaveDays,
    settings.gpsCheckInEnabled, settings.geofenceLat, settings.geofenceLng, settings.geofenceRadius,
    settings.gatewayTwilioSid, settings.gatewayTwilioToken, settings.gatewayTwilioFrom,
    settings.gatewaySendgridKey, settings.gatewaySmtpHost, settings.gatewaySmtpUser, settings.gatewaySmtpPass
  ]);

  return (
    <div className="page-wrap active">
      <div className="grid">
        <div className="card">
          <div className="card-head"><div><div className="card-title">Organisation</div><div className="card-sub">Basic workspace details</div></div></div>
          <div className="form-grid">
            <label className="field field-full">
              <span className="field-label">Organisation name</span>
              <input className="input" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
            </label>
            <label className="field field-full">
              <span className="field-label">Work week</span>
              <select className="input" value={workWeek} onChange={(e) => setWorkWeek(e.target.value)}>
                <option value="5-day">5-day (Mon–Fri)</option>
                <option value="5.5-day">5.5-day</option>
                <option value="6-day">6-day</option>
              </select>
            </label>
            <label className="field field-full">
              <span className="field-label">Annual leave allowance</span>
              <input
                type="number"
                min="0"
                className="input"
                value={totalLeaveDays}
                onChange={(e) => setTotalLeaveDays(e.target.value)}
              />
            </label>
          </div>
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button
              className="btn"
              onClick={() => updateSettings({ orgName, workWeek, totalLeaveDays: Number(totalLeaveDays) || 0 })}
            >
              Save changes
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div><div className="card-title">Notifications & security</div><div className="card-sub">Control what reaches you</div></div></div>
          <div className="settings-rows">
            <Row label="Leave request alerts" sub="Notify me when leave is raised"
              on={settings.notifyLeave} onToggle={() => toggleSetting('notifyLeave')} />
            <Row label="Payroll reminders" sub="Before each payroll cycle closes"
              on={settings.notifyPayroll} onToggle={() => toggleSetting('notifyPayroll')} />
            <Row label="Birthday nudges" sub="Daily celebration digest"
              on={settings.notifyBirthday} onToggle={() => toggleSetting('notifyBirthday')} />
            <Row label="Two-factor authentication" sub="Extra security on sign-in"
              on={settings.twoFactor} onToggle={() => toggleSetting('twoFactor')} />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Active sessions</div>
            <div className="card-sub">Devices currently signed in to your account</div>
          </div>
          {sessions.length > 1 && (
            <button className="btn btn-ghost" onClick={handleRevokeOthers}>Sign out other sessions</button>
          )}
        </div>
        <div className="settings-rows">
          {sessions.length === 0 && <div className="empty">No active sessions.</div>}
          {sessions.map((s) => (
            <div className="settings-row" key={s.id}>
              <div>
                <div className="settings-row-label">
                  {s.userAgent || 'Unknown device'}{s.current && <span className="state-badge approved" style={{ marginLeft: 8 }}>This device</span>}
                </div>
                <div className="settings-row-sub">
                  Signed in {new Date(s.createdAt).toLocaleString('en-IN')}{s.ip ? ` · ${s.ip}` : ''}
                </div>
              </div>
              {!s.current && (
                <button className="mini-btn danger" onClick={() => handleRevokeSession(s.id)}>Sign out</button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Notification channels</div>
            <div className="card-sub">Where each alert type is delivered (WhatsApp/SMS need a transport configured — interface only for now)</div>
          </div>
        </div>
        <div className="settings-rows">
          <ChannelRow label="Leave alerts" sub="New requests & approvals" selected={notifyChannels.leave || []} onToggle={(ch) => toggleChannel('leave', ch)} />
          <ChannelRow label="Payroll alerts" sub="Cycle reminders & ready slips" selected={notifyChannels.payroll || []} onToggle={(ch) => toggleChannel('payroll', ch)} />
          <ChannelRow label="Birthday & anniversary" sub="Daily celebration digest" selected={notifyChannels.birthday || []} onToggle={(ch) => toggleChannel('birthday', ch)} />
        </div>
      </div>

      <div className="grid" style={{ marginTop: 18 }}>
        {/* GPS Geofencing Settings */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">GPS Geofencing</div>
              <div className="card-sub">Enforce check-ins only inside office coordinates</div>
            </div>
            <Toggle on={gpsCheckInEnabled} onClick={() => setGpsCheckInEnabled(!gpsCheckInEnabled)} />
          </div>
          <div className="form-grid" style={{ opacity: gpsCheckInEnabled ? 1 : 0.6, pointerEvents: gpsCheckInEnabled ? 'auto' : 'none', transition: 'all 0.2s' }}>
            <label className="field field-full">
              <span className="field-label">Latitude</span>
              <input type="number" step="any" className="input mono" value={geofenceLat} onChange={(e) => setGeofenceLat(parseFloat(e.target.value) || 0)} />
            </label>
            <label className="field field-full">
              <span className="field-label">Longitude</span>
              <input type="number" step="any" className="input mono" value={geofenceLng} onChange={(e) => setGeofenceLng(parseFloat(e.target.value) || 0)} />
            </label>
            <label className="field field-full">
              <span className="field-label">Radius (meters)</span>
              <input type="number" min="10" className="input mono" value={geofenceRadius} onChange={(e) => setGeofenceRadius(parseInt(e.target.value) || 25)} />
              <span className="muted-text" style={{ fontSize: '11.5px', marginTop: 4, display: 'block' }}>
                20–30m most reliably blocks off-site check-ins while tolerating normal GPS drift. Very small values (&lt;15m) risk false rejections indoors; large values (&gt;100m) weaken anti-proxy protection.
              </span>
            </label>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button type="button" className="btn btn-ghost" style={{ padding: '6px 12px', fontSize: '12px' }} onClick={fetchCurrentLocation}>
                Use Current Location
              </button>
            </div>
          </div>
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="btn"
              onClick={() => {
                updateSettings({
                  gpsCheckInEnabled,
                  geofenceLat: Number(geofenceLat),
                  geofenceLng: Number(geofenceLng),
                  geofenceRadius: Number(geofenceRadius),
                });
              }}
            >
              Save Geofence
            </button>
          </div>
        </div>

        {/* API Gateway Settings */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">API Gateway Credentials</div>
              <div className="card-sub">Configure WhatsApp, SMS, & SMTP credentials</div>
            </div>
          </div>
          <div className="form-grid">
            <div style={{ gridColumn: 'span 2', fontWeight: 600, fontSize: 13, borderBottom: '1px solid var(--line)', paddingBottom: 4, marginBottom: 4 }}>
              Twilio Gateway Settings (SMS & WhatsApp)
            </div>
            <label className="field">
              <span className="field-label">Account SID</span>
              <input type="password" placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxx" className="input mono" value={twilioSid} onChange={(e) => setTwilioSid(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Auth Token</span>
              <input type="password" placeholder="••••••••••••••••••••••••" className="input mono" value={twilioToken} onChange={(e) => setTwilioToken(e.target.value)} />
            </label>
            <label className="field field-full">
              <span className="field-label">From Number / Sender ID</span>
              <input type="text" placeholder="+1415xxxxxxx" className="input mono" value={twilioFrom} onChange={(e) => setTwilioFrom(e.target.value)} />
            </label>

            <div style={{ gridColumn: 'span 2', fontWeight: 600, fontSize: 13, borderBottom: '1px solid var(--line)', paddingBottom: 4, marginTop: 12, marginBottom: 4 }}>
              SMTP Email Gateway Settings
            </div>
            <label className="field">
              <span className="field-label">SMTP Host</span>
              <input type="text" placeholder="smtp.sendgrid.net" className="input mono" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">SMTP Username</span>
              <input type="text" placeholder="apikey" className="input mono" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />
            </label>
            <label className="field field-full">
              <span className="field-label">SMTP Password / API Key</span>
              <input type="password" placeholder="SG.xxxxxxxxxxxxx" className="input mono" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} />
            </label>
          </div>
          <div className="modal-actions" style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn"
              onClick={() => {
                updateSettings({
                  gatewayTwilioSid: twilioSid,
                  gatewayTwilioToken: twilioToken,
                  gatewayTwilioFrom: twilioFrom,
                  gatewaySmtpHost: smtpHost,
                  gatewaySmtpUser: smtpUser,
                  gatewaySmtpPass: smtpPass,
                });
              }}
            >
              Save Credentials
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Notification Templates Editor</div>
            <div className="card-sub">Customize Email, SMS, and WhatsApp alerts copy sent to employees</div>
          </div>
        </div>
        <div className="form-grid template-editor-grid" style={{ gap: 24, padding: '12px 24px' }}>
          <div>
            <label className="field field-full">
              <span className="field-label">Delivery Channel</span>
              <select className="input" value={templateChannel} onChange={(e) => setTemplateChannel(e.target.value)}>
                <option value="email">Email Template</option>
                <option value="sms">SMS Template</option>
                <option value="whatsapp">WhatsApp Template</option>
              </select>
            </label>
            <label className="field field-full" style={{ marginTop: 12 }}>
              <span className="field-label">Template Event</span>
              <select className="input" value={templateName} onChange={(e) => setTemplateName(e.target.value)}>
                <option value="leaveApproval">Leave Request Approved</option>
                <option value="payrollSlip">Salary Slip Published</option>
              </select>
            </label>
            <label className="field field-full" style={{ marginTop: 12 }}>
              <span className="field-label">Template Text Body</span>
              <textarea
                className="input mono"
                rows={7}
                value={templateText}
                onChange={(e) => setTemplateText(e.target.value)}
                placeholder="Enter alert copy..."
              />
              <span className="muted-text" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                Variables allowed: <code>{"{employee}"}</code>, <code>{"{date}"}</code>
              </span>
            </label>
            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const currentTemplates = settings.notificationTemplates || {
                    email: { leaveApproval: '', payrollSlip: '' },
                    sms: { leaveApproval: '', payrollSlip: '' },
                    whatsapp: { leaveApproval: '', payrollSlip: '' }
                  };
                  updateSettings({
                    notificationTemplates: {
                      ...currentTemplates,
                      [templateChannel]: {
                        ...currentTemplates[templateChannel],
                        [templateName]: templateText
                      }
                    }
                  });
                }}
              >
                Save Template
              </button>
            </div>
          </div>

          {/* Visual Phone Mockup Preview */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-2)', border: '1px dashed var(--line)', borderRadius: '12px', padding: 24 }}>
            <div style={{ fontWeight: 600, fontSize: 12, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 12, color: 'var(--muted)' }}>
              Dynamic Preview ({templateChannel.toUpperCase()})
            </div>

            {templateChannel === 'email' ? (
              <div style={{ width: '100%', maxWidth: '340px', background: '#fff', border: '1px solid var(--line)', borderRadius: '8px', boxShadow: '0 4px 10px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', background: 'var(--bg-2)', fontSize: '11px', color: 'var(--muted)' }}>
                  <strong>From:</strong> People Ops &lt;no-reply@smaatech.co&gt;
                </div>
                <div style={{ padding: '12px', fontSize: '12.5px', whiteSpace: 'pre-line', minHeight: '140px', lineHeight: 1.5, fontFamily: 'monospace' }}>
                  {templateText.replace('{employee}', 'Priya Sharma').replace('{date}', 'July 2026')}
                </div>
              </div>
            ) : (
              /* Phone wrapper */
              <div style={{ width: '220px', height: '320px', background: '#000', borderRadius: '28px', border: '6px solid #333', padding: '12px 6px', display: 'flex', flexDirection: 'column', position: 'relative', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}>
                {/* Speaker top */}
                <div style={{ width: '40px', height: '6px', background: '#333', borderRadius: '3px', alignSelf: 'center', marginBottom: 10 }}></div>
                
                {/* Screen area */}
                <div style={{ flex: 1, background: templateChannel === 'whatsapp' ? '#efeae2' : '#fff', borderRadius: '16px', padding: '8px', overflowY: 'auto', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                  {templateChannel === 'whatsapp' ? (
                    <div style={{ maxWidth: '90%', background: '#d9fdd3', borderRadius: '8px', padding: '8px', fontSize: '11px', boxShadow: '0 1px 1px rgba(0,0,0,0.1)', alignSelf: 'flex-start', whiteSpace: 'pre-line', wordBreak: 'break-word', lineHeight: 1.4, fontFamily: 'monospace' }}>
                      {templateText.replace('{employee}', 'Priya Sharma').replace('{date}', 'July 2026')}
                      <div style={{ fontSize: '8px', textAlign: 'right', color: 'var(--muted)', marginTop: '2px' }}>12:30 PM ✓✓</div>
                    </div>
                  ) : (
                    <div style={{ maxWidth: '95%', background: 'var(--bg-2)', borderRadius: '12px', padding: '8px', fontSize: '11px', alignSelf: 'flex-start', whiteSpace: 'pre-line', wordBreak: 'break-word', lineHeight: 1.4, fontFamily: 'monospace' }}>
                      {templateText.replace('{employee}', 'Priya Sharma').replace('{date}', 'July 2026')}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid" style={{ marginTop: 18 }}>
        <ChipManager
          label="Departments"
          sub="Used across employee profiles & filters"
          items={deptValues.map((v) => v.value)}
          onAdd={(v) => deptCategory && addMasterValue(deptCategory.id, v)}
          onRemove={(v) => {
            const row = deptValues.find((x) => x.value === v);
            if (row) deleteMasterValue(row.id);
          }}
          placeholder="e.g. Customer Success"
        />
        <ChipManager
          label="Locations"
          sub="Used across employee profiles & filters"
          items={locValues.map((v) => v.value)}
          onAdd={(v) => locCategory && addMasterValue(locCategory.id, v)}
          onRemove={(v) => {
            const row = locValues.find((x) => x.value === v);
            if (row) deleteMasterValue(row.id);
          }}
          placeholder="e.g. Kolkata"
        />
        <ChipManager
          label="Designations"
          sub="Suggested roles when adding employees"
          items={designations}
          onAdd={addDesignation}
          onRemove={removeDesignation}
          placeholder="e.g. Staff Engineer"
        />
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Users & role access</div>
            <div className="card-sub">{users.length} login profiles</div>
          </div>
          <button className="btn" onClick={openAddUser}><IconPlus width="14" height="14" /> Add user</button>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Role</th><th>Email</th><th>Scope</th><th>Face login</th><th style={{ textAlign: 'right' }}>Action</th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}{u.id === currentUser.id ? ' (you)' : ''}</td>
                  <td><span className="state-badge approved">{u.role}</span></td>
                  <td className="mono">{u.email}</td>
                  <td>{ROLE_SCOPE[u.role] || ''}</td>
                  <td>
                    <span className="muted-text">Managed on server</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="row-actions">
                      <button className="mini-btn" onClick={() => setFaceEnrollUser(u)}>
                        Enroll / re-enroll face
                      </button>
                      <button className="icon-btn sm" title="Edit" onClick={() => openEditUser(u)}>
                        <IconEdit width="14" height="14" />
                      </button>
                      <button className="icon-btn sm danger" title="Remove" disabled={users.length <= 1} onClick={() => setConfirmRemoveUser(u)}>
                        <IconTrash width="14" height="14" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18, borderColor: 'var(--red)' }}>
        <div className="card-head">
          <div>
            <div className="card-title" style={{ color: 'var(--red)' }}>Danger zone</div>
            <div className="card-sub">Reset all employees, leave, payroll & settings to defaults</div>
          </div>
          <button className="btn btn-danger" onClick={() => setConfirmReset(true)}>Reset all data</button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Activity history</div>
            <div className="card-sub">{auditTotal} event{auditTotal === 1 ? '' : 's'} recorded</div>
          </div>
        </div>
        <div className="settings-rows">
          {auditRows.length === 0 && <div className="empty">No activity recorded yet.</div>}
          {auditRows.map((item) => (
            <div className="settings-row" key={item.id}>
              <div>
                <div className="settings-row-label">{item.action} - {item.subject}</div>
                <div className="settings-row-sub">
                  {new Date(item.at).toLocaleString('en-IN')} by {item.actor}
                  {item.details ? ` - ${item.details}` : ''}
                </div>
              </div>
              {item.role && <span className="state-badge approved">{item.role}</span>}
            </div>
          ))}
        </div>
        {auditTotal > AUDIT_PAGE_SIZE && (
          <div className="pager">
            <button className="mini-btn" disabled={auditPage === 1} onClick={() => setAuditPage((p) => p - 1)}>Previous</button>
            <span className="pager-meta">Page {auditPage} of {Math.ceil(auditTotal / AUDIT_PAGE_SIZE)}</span>
            <button className="mini-btn approve" disabled={auditPage >= Math.ceil(auditTotal / AUDIT_PAGE_SIZE)} onClick={() => setAuditPage((p) => p + 1)}>Next</button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmReset}
        title="Reset everything?"
        message="This wipes every change you’ve made and restores the original sample dataset. This can’t be undone."
        confirmLabel="Reset all data"
        onCancel={() => setConfirmReset(false)}
        onConfirm={async () => { await resetDatabase(); setConfirmReset(false); }}
      />

      <UserForm
        open={userFormOpen}
        user={editingUser}
        employees={employees}
        onClose={() => setUserFormOpen(false)}
        onSave={saveUser}
      />

      <FaceEnrollModal
        open={Boolean(faceEnrollUser)}
        user={faceEnrollUser}
        onClose={() => setFaceEnrollUser(null)}
        onSave={saveFaceDescriptor}
      />

      <ConfirmDialog
        open={Boolean(confirmRemoveUser)}
        title="Remove user"
        message={confirmRemoveUser ? `Remove the login profile for ${confirmRemoveUser.name}?` : ''}
        confirmLabel="Remove"
        onCancel={() => setConfirmRemoveUser(null)}
        onConfirm={() => removeUser(confirmRemoveUser.id)}
      />
    </div>
  );
}

function Row({ label, sub, on, onToggle }) {
  return (
    <div className="settings-row">
      <div>
        <div className="settings-row-label">{label}</div>
        <div className="settings-row-sub">{sub}</div>
      </div>
      <Toggle on={on} onClick={onToggle} />
    </div>
  );
}
