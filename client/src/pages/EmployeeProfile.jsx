import { useMemo, useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useHRMS } from '../context/HRMSContext';
import Avatar from '../components/Avatar';
import Modal from '../components/Modal';
import {
  formatINR, formatDate, daysBetween, leaveTagClass, leaveTagLabel, todayISO,
} from '../lib/helpers';

const STATUS_LABEL = { active: 'Active', remote: 'Remote', 'on-leave': 'On leave' };
const LEAVE_BADGE = { pending: 'pending', approved: 'approved', declined: 'declined' };

export default function EmployeeProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const {
    employees, leaves, attendance, payroll, assets, expenses, settings, updateEmployee, currentUser, toast,
    documents, downloadDocument
  } = useHRMS();

  const emp = employees.find((e) => e.id === id);

  const manager = useMemo(
    () => (emp?.managerId ? employees.find((e) => e.id === emp.managerId) : null),
    [employees, emp],
  );

  const reports = useMemo(
    () => employees.filter((e) => e.managerId === emp?.id),
    [employees, emp],
  );

  const myLeaves = useMemo(
    () => leaves.filter((l) => l.empId === emp?.id || l.name === emp?.name),
    [leaves, emp],
  );

  const myAttendance = useMemo(
    () => attendance
      .filter((a) => a.empId === emp?.id || a.name === emp?.name)
      .sort((a, b) => String(b.date).localeCompare(String(a.date))),
    [attendance, emp],
  );

  const myPayroll = useMemo(
    () => payroll.filter((p) => p.empId === emp?.id || p.name === emp?.name),
    [payroll, emp],
  );

  const myAssets = useMemo(
    () => assets.filter((a) => a.assignedToEmpId === emp?.id),
    [assets, emp],
  );

  const myExpenses = useMemo(
    () => expenses.filter((x) => x.empId === emp?.id || x.name === emp?.name),
    [expenses, emp],
  );

  const myDocs = useMemo(() => {
    if (!emp) return [];
    return documents.filter(d => String(d.ownerId) === String(emp.id) || d.owner === emp.name);
  }, [documents, emp]);

  const leaveBalance = useMemo(() => {
    const total = Number(settings.totalLeaveDays || 24);
    const used = myLeaves
      .filter((l) => l.status === 'approved')
      .reduce((sum, l) => sum + daysBetween(l.start, l.end), 0);
    const pending = myLeaves
      .filter((l) => l.status === 'pending')
      .reduce((sum, l) => sum + daysBetween(l.start, l.end), 0);
    return { total, used, pending, remaining: Math.max(0, total - used) };
  }, [myLeaves, settings.totalLeaveDays]);

  const [tenure, setTenure] = useState('—');
  useEffect(() => {
    if (!emp?.joinDate) {
      setTenure('—');
      return;
    }
    const years = (Date.now() - new Date(emp.joinDate).getTime()) / (365.25 * 86400000);
    setTenure(years >= 1 ? `${years.toFixed(1)} yrs` : `${Math.max(1, Math.round(years * 12))} mo`);
  }, [emp?.joinDate]);

  const todayRecord = myAttendance.find((a) => a.date === todayISO());

  // 360 Profile tab and editing states
  const [profileTab, setProfileTab] = useState('overview'); // 'overview' | 'personal' | 'bank' | 'history' | 'family' | 'documents'
  const [editSection, setEditSection] = useState(null); // 'personal' | 'bank' | 'education' | 'experience' | 'family'
  const [skillInput, setSkillInput] = useState('');

  // Forms states
  const [personalForm, setPersonalForm] = useState({
    dob: '', gender: '', bloodGroup: '', personalEmail: '', phone: '',
    emergencyName: '', emergencyRelation: '', emergencyPhone: ''
  });
  
  const [bankForm, setBankForm] = useState({
    bankName: '', bankAccount: '', ifsc: ''
  });

  const [eduForm, setEduForm] = useState({ degree: '', institution: '', year: '', grade: '' });
  const [expForm, setExpForm] = useState({ company: '', role: '', from: '', to: '' });
  const [famForm, setFamForm] = useState({ name: '', relation: '', phone: '' });

  const isHR = ['HR Director', 'HR Manager'].includes(currentUser.role);
  const isOwnProfile = currentUser.empId === id;
  const canEdit = isHR || isOwnProfile;

  const startEditPersonal = () => {
    setPersonalForm({
      dob: emp.dob || '',
      gender: emp.gender || '',
      bloodGroup: emp.bloodGroup || '',
      personalEmail: emp.personalEmail || '',
      phone: emp.phone || '',
      emergencyName: emp.emergencyContact?.name || '',
      emergencyRelation: emp.emergencyContact?.relation || '',
      emergencyPhone: emp.emergencyContact?.phone || ''
    });
    setEditSection('personal');
  };

  const startEditBank = () => {
    setBankForm({
      bankName: emp.bankName || '',
      bankAccount: emp.bankAccount || '',
      ifsc: emp.ifsc || ''
    });
    setEditSection('bank');
  };

  const savePersonal = async () => {
    const payload = {
      dob: personalForm.dob,
      gender: personalForm.gender,
      bloodGroup: personalForm.bloodGroup,
      personalEmail: personalForm.personalEmail,
      phone: personalForm.phone,
      emergencyContact: {
        name: personalForm.emergencyName,
        relation: personalForm.emergencyRelation,
        phone: personalForm.emergencyPhone
      }
    };
    await updateEmployee(emp.id, payload);
    setEditSection(null);
    toast('success', 'Personal information updated successfully');
  };

  const saveBank = async () => {
    const payload = {
      bankName: bankForm.bankName,
      bankAccount: bankForm.bankAccount,
      ifsc: bankForm.ifsc
    };
    await updateEmployee(emp.id, payload);
    setEditSection(null);
    toast('success', 'Bank details updated successfully');
  };

  const handleAddSkill = async () => {
    if (!skillInput.trim()) return;
    const currentSkills = emp.skills || [];
    if (currentSkills.includes(skillInput.trim())) {
      setSkillInput('');
      return;
    }
    await updateEmployee(emp.id, { skills: [...currentSkills, skillInput.trim()] });
    setSkillInput('');
    toast('success', 'Skill tag added');
  };

  const handleRemoveSkill = async (skillToRemove) => {
    const currentSkills = emp.skills || [];
    const nextSkills = currentSkills.filter(s => s !== skillToRemove);
    await updateEmployee(emp.id, { skills: nextSkills });
    toast('info', 'Skill tag removed');
  };

  const addEducation = async () => {
    if (!eduForm.degree || !eduForm.institution) return;
    const currentEdu = emp.education || [];
    await updateEmployee(emp.id, {
      education: [...currentEdu, eduForm]
    });
    setEduForm({ degree: '', institution: '', year: '', grade: '' });
    setEditSection(null);
    toast('success', 'Education detail added');
  };

  const removeEducation = async (idx) => {
    const nextEdu = (emp.education || []).filter((_, i) => i !== idx);
    await updateEmployee(emp.id, { education: nextEdu });
    toast('info', 'Education detail removed');
  };

  const addExperience = async () => {
    if (!expForm.company || !expForm.role) return;
    const currentExp = emp.experience || [];
    await updateEmployee(emp.id, {
      experience: [...currentExp, expForm]
    });
    setExpForm({ company: '', role: '', from: '', to: '' });
    setEditSection(null);
    toast('success', 'Experience detail added');
  };

  const removeExperience = async (idx) => {
    const nextExp = (emp.experience || []).filter((_, i) => i !== idx);
    await updateEmployee(emp.id, { experience: nextExp });
    toast('info', 'Experience detail removed');
  };

  const addFamily = async () => {
    if (!famForm.name || !famForm.relation) return;
    const currentFam = emp.family || [];
    await updateEmployee(emp.id, {
      family: [...currentFam, famForm]
    });
    setFamForm({ name: '', relation: '', phone: '' });
    setEditSection(null);
    toast('success', 'Family member added');
  };

  const removeFamily = async (idx) => {
    const nextFam = (emp.family || []).filter((_, i) => i !== idx);
    await updateEmployee(emp.id, { family: nextFam });
    toast('info', 'Family member removed');
  };

  const openFile = async (doc) => {
    try {
      toast('info', 'Downloading file from server...');
      const blob = await downloadDocument(doc.id);
      if (!blob) {
        toast('error', 'File not found on server.');
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = doc.title || 'download';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch {
      toast('error', 'Could not open this file.');
    }
  };

  if (!emp) {
    return (
      <div className="page-wrap active">
        <div className="card">
          <div className="card-title">Employee not found</div>
          <p className="muted-text" style={{ marginTop: 8 }}>
            This record may have been removed. <Link to="/employees">Back to directory</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-wrap active">
      {/* Header card */}
      <div className="card">
        <div className="card-head" style={{ alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', minWidth: 0 }}>
            <Avatar name={emp.name} photo={emp.photo} size={64} />
            <div style={{ minWidth: 0 }}>
              <div className="card-title" style={{ fontSize: 22 }}>{emp.name}</div>
              <div className="card-sub">{emp.role} · {emp.dept} · 📍 {emp.loc}</div>
              <div className="card-sub mono" style={{ marginTop: 4 }}>
                {emp.email}{emp.phone ? ` · ${emp.phone}` : ''}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className={`status-pill status-${emp.status}`}>{STATUS_LABEL[emp.status] || emp.status}</span>
            <button className="btn btn-ghost" onClick={() => navigate('/employees')}>← Directory</button>
          </div>
        </div>
        <div className="card-sub" style={{ marginTop: 4 }}>
          Joined {formatDate(emp.joinDate)} · Reports to{' '}
          {manager
            ? <Link to={`/employees/${manager.id}`}>{manager.name}</Link>
            : <span>—</span>}
          {reports.length > 0 && <> · {reports.length} direct report{reports.length > 1 ? 's' : ''}</>}
        </div>
      </div>

      {/* Tabs navigation */}
      <div style={{ display: 'flex', gap: 12, borderBottom: '1px solid var(--line)', padding: '4px 0', margin: '16px 0 20px 0' }}>
        {[
          { id: 'overview', label: 'Overview & Activity' },
          { id: 'personal', label: 'Personal & Official Info' },
          { id: 'bank', label: 'Bank Details' },
          { id: 'history', label: 'Education & Career' },
          { id: 'family', label: 'Family Relations' },
          { id: 'documents', label: 'Documents' }
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setProfileTab(t.id)}
            className={`btn ${profileTab === t.id ? '' : 'btn-ghost'}`}
            style={{ padding: '6px 14px', fontSize: 13, border: 'none' }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {profileTab === 'overview' && (
        <>
          {/* Stats */}
          <div className="stats">
            <div className="stat">
              <div className="stat-label">Leave balance</div>
              <div className="stat-value">{leaveBalance.remaining}<small style={{ fontSize: 14 }}> / {leaveBalance.total} days</small></div>
              <div className="stat-meta">{leaveBalance.used} used · {leaveBalance.pending} pending</div>
            </div>
            <div className="stat">
              <div className="stat-label">Today</div>
              <div className="stat-value" style={{ textTransform: 'capitalize' }}>{todayRecord?.status || 'No record'}</div>
              <div className="stat-meta">{todayRecord?.checkIn ? `In at ${todayRecord.checkIn}` : 'Not checked in'}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Performance</div>
              <div className="stat-value">{emp.rating ? `${emp.rating} ★` : '—'}</div>
              <div className="stat-meta">latest rating</div>
            </div>
            <div className="stat">
              <div className="stat-label">Tenure</div>
              <div className="stat-value">{tenure}</div>
              <div className="stat-meta">monthly gross {formatINR(emp.salary)}</div>
            </div>
          </div>

          <div className="grid" style={{ alignItems: 'start', marginTop: 18 }}>
            {/* Leave history */}
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Leave history</div>
                  <div className="card-sub">{myLeaves.length} request{myLeaves.length === 1 ? '' : 's'}</div>
                </div>
              </div>
              {myLeaves.length === 0 ? (
                <div className="empty">No leave requests yet.</div>
              ) : (
                <div className="table-scroll">
                  <table className="table">
                    <thead>
                      <tr><th>Type</th><th>Dates</th><th>Days</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {myLeaves.map((l) => (
                        <tr key={l.id}>
                          <td><span className={`tag ${leaveTagClass(l.type)}`}>{leaveTagLabel(l.type)}</span></td>
                          <td>{formatDate(l.start)} – {formatDate(l.end)}</td>
                          <td>{daysBetween(l.start, l.end)}</td>
                          <td><span className={`state-badge ${LEAVE_BADGE[l.status] || 'pending'}`}>{l.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Payroll records */}
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Payroll</div>
                  <div className="card-sub">salary records by cycle</div>
                </div>
              </div>
              {myPayroll.length === 0 ? (
                <div className="empty">No payroll records.</div>
              ) : (
                <div className="table-scroll">
                  <table className="table">
                    <thead>
                      <tr><th>Cycle</th><th>Gross</th><th>Deductions</th><th>Net</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {myPayroll.map((p) => (
                        <tr key={p.id}>
                          <td className="mono">{p.cycle}</td>
                          <td className="mono">{formatINR(p.gross)}</td>
                          <td className="mono">{formatINR(p.deductions)}</td>
                          <td className="mono"><strong>{formatINR(p.net)}</strong></td>
                          <td><span className={`state-badge ${p.status === 'paid' ? 'approved' : 'pending'}`}>{p.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Assets */}
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Assigned assets</div>
                  <div className="card-sub">{myAssets.length} item{myAssets.length === 1 ? '' : 's'}</div>
                </div>
              </div>
              {myAssets.length === 0 ? (
                <div className="empty">No assets assigned.</div>
              ) : (
                <div className="table-scroll">
                  <table className="table">
                    <thead>
                      <tr><th>Asset</th><th>Category</th><th>Serial</th><th>Since</th></tr>
                    </thead>
                    <tbody>
                      {myAssets.map((a) => (
                        <tr key={a.id}>
                          <td><strong>{a.name}</strong></td>
                          <td>{a.category}</td>
                          <td className="mono">{a.serialNumber}</td>
                          <td>{formatDate(a.assignedDate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Expenses */}
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Expense claims</div>
                  <div className="card-sub">{myExpenses.length} claim{myExpenses.length === 1 ? '' : 's'}</div>
                </div>
              </div>
              {myExpenses.length === 0 ? (
                <div className="empty">No expense claims.</div>
              ) : (
                <div className="table-scroll">
                  <table className="table">
                    <thead>
                      <tr><th>Category</th><th>Amount</th><th>Date</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {myExpenses.map((x) => (
                        <tr key={x.id}>
                          <td>{x.category}</td>
                          <td className="mono">{formatINR(x.amount)}</td>
                          <td>{formatDate(x.date)}</td>
                          <td><span className={`state-badge ${x.status === 'approved' ? 'approved' : x.status === 'declined' ? 'declined' : 'pending'}`}>{x.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {profileTab === 'personal' && (
        <div className="grid">
          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Personal Information</div>
                <div className="card-sub">Private contact details & identity info</div>
              </div>
              {canEdit && (
                <button className="btn btn-ghost" onClick={startEditPersonal}>Edit Details</button>
              )}
            </div>
            <div className="settings-rows">
              <div className="settings-row">
                <div>
                  <div className="settings-row-sub">Date of Birth</div>
                  <div className="settings-row-label" style={{ fontSize: 14 }}>{emp.dob ? formatDate(emp.dob) : '—'}</div>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row-sub">Gender</div>
                  <div className="settings-row-label" style={{ fontSize: 14, textTransform: 'capitalize' }}>{emp.gender || '—'}</div>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row-sub">Blood Group</div>
                  <div className="settings-row-label" style={{ fontSize: 14 }}>{emp.bloodGroup || '—'}</div>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row-sub">Personal Email Address</div>
                  <div className="settings-row-label mono" style={{ fontSize: 14 }}>{emp.personalEmail || '—'}</div>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row-sub">Emergency Contact Person</div>
                  <div className="settings-row-label" style={{ fontSize: 14 }}>
                    {emp.emergencyContact?.name 
                      ? `${emp.emergencyContact.name} (${emp.emergencyContact.relation || 'Relation unspecified'})`
                      : '—'}
                  </div>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row-sub">Emergency Contact Phone</div>
                  <div className="settings-row-label mono" style={{ fontSize: 14 }}>{emp.emergencyContact?.phone || '—'}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Official Details</div>
                <div className="card-sub">Employment scope & position specifications</div>
              </div>
            </div>
            <div className="settings-rows">
              <div className="settings-row">
                <div>
                  <div className="settings-row-sub">Designation / Role</div>
                  <div className="settings-row-label" style={{ fontSize: 14 }}>{emp.role}</div>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row-sub">Department</div>
                  <div className="settings-row-label" style={{ fontSize: 14 }}>{emp.dept}</div>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row-sub">Employment Type</div>
                  <div className="settings-row-label" style={{ fontSize: 14 }}>{emp.employmentType || 'Full-time'}</div>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row-sub">Assigned Workspace Location</div>
                  <div className="settings-row-label" style={{ fontSize: 14 }}>{emp.loc}</div>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row-sub">Joining Date</div>
                  <div className="settings-row-label" style={{ fontSize: 14 }}>{formatDate(emp.joinDate)}</div>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <div className="settings-row-sub">Manager / Direct Supervisor</div>
                  <div className="settings-row-label" style={{ fontSize: 14 }}>{manager ? manager.name : '—'}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {profileTab === 'bank' && (
        <div className="card" style={{ maxWidth: '600px', margin: '0 auto' }}>
          <div className="card-head">
            <div>
              <div className="card-title">Salary & Bank account</div>
              <div className="card-sub">Financial routing details for payroll deposits</div>
            </div>
            {canEdit && (
              <button className="btn btn-ghost" onClick={startEditBank}>Edit Details</button>
            )}
          </div>
          <div className="settings-rows">
            <div className="settings-row">
              <div>
                <div className="settings-row-sub">Bank Name</div>
                <div className="settings-row-label" style={{ fontSize: 14 }}>{emp.bankName || '—'}</div>
              </div>
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-sub">Bank Account Number</div>
                <div className="settings-row-label mono" style={{ fontSize: 14 }}>{emp.bankAccount || '—'}</div>
              </div>
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-sub">IFSC Code</div>
                <div className="settings-row-label mono" style={{ fontSize: 14 }}>{emp.ifsc || '—'}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {profileTab === 'history' && (
        <div className="grid">
          {/* Skills Management Panel */}
          <div className="card" style={{ gridColumn: 'span 2' }}>
            <div className="card-head">
              <div>
                <div className="card-title">Professional Skills</div>
                <div className="card-sub">Technical tags & core capabilities</div>
              </div>
            </div>
            
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '12px 0' }}>
              {(!emp.skills || emp.skills.length === 0) ? (
                <span className="muted-text" style={{ fontSize: 13 }}>No skills tagged yet.</span>
              ) : (
                emp.skills.map((skill, index) => (
                  <span key={index} className="tag approved" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', fontSize: 12, borderRadius: 12 }}>
                    {skill}
                    {canEdit && (
                      <button 
                        type="button" 
                        onClick={() => handleRemoveSkill(skill)}
                        style={{ border: 'none', background: 'none', color: '#dc3545', cursor: 'pointer', padding: 0, fontWeight: 'bold' }}
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))
              )}
            </div>

            {canEdit && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8, maxWidth: 320 }}>
                <input 
                  type="text" 
                  className="input compact" 
                  placeholder="Add skill tag (e.g. React)" 
                  value={skillInput} 
                  onChange={(e) => setSkillInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddSkill()}
                />
                <button className="btn btn-compact" onClick={handleAddSkill}>Add</button>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Education History</div>
                <div className="card-sub">Qualifications and certifications</div>
              </div>
              {canEdit && (
                <button className="btn" onClick={() => setEditSection('education')}>Add Education</button>
              )}
            </div>
            {(!emp.education || emp.education.length === 0) ? (
              <div className="empty">No education details added yet.</div>
            ) : (
              <div className="leave-list">
                {emp.education.map((edu, i) => (
                  <div className="leave-item" key={i} style={{ padding: '14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%' }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{edu.degree}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{edu.institution}</div>
                        <div style={{ fontSize: 12, marginTop: 4 }}>Passed: {edu.year} · Grade: {edu.grade || '—'}</div>
                      </div>
                      {canEdit && (
                        <button className="mini-btn danger" onClick={() => removeEducation(i)}>Remove</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">Work Experience</div>
                <div className="card-sub">Previous employment records</div>
              </div>
              {canEdit && (
                <button className="btn" onClick={() => setEditSection('experience')}>Add Experience</button>
              )}
            </div>
            {(!emp.experience || emp.experience.length === 0) ? (
              <div className="empty">No work experience added yet.</div>
            ) : (
              <div className="leave-list">
                {emp.experience.map((exp, i) => (
                  <div className="leave-item" key={i} style={{ padding: '14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%' }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{exp.role}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{exp.company}</div>
                        <div style={{ fontSize: 12, marginTop: 4 }}>Period: {exp.from || '—'} to {exp.to || 'Present'}</div>
                      </div>
                      {canEdit && (
                        <button className="mini-btn danger" onClick={() => removeExperience(i)}>Remove</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {profileTab === 'family' && (
        <div className="card" style={{ maxWidth: '650px', margin: '0 auto' }}>
          <div className="card-head">
            <div>
              <div className="card-title">Family dependents</div>
              <div className="card-sub">Emergency context and family relation logs</div>
            </div>
            {canEdit && (
              <button className="btn" onClick={() => setEditSection('family')}>Add Family Member</button>
            )}
          </div>
          {(!emp.family || emp.family.length === 0) ? (
            <div className="empty">No family details registered.</div>
          ) : (
            <div className="leave-list">
              {emp.family.map((fam, i) => (
                <div className="leave-item" key={i} style={{ padding: '14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%' }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{fam.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>Relation: {fam.relation}</div>
                      {fam.phone && <div style={{ fontSize: 12, marginTop: 4, fontFamily: 'monospace' }}>Phone: {fam.phone}</div>}
                    </div>
                    {canEdit && (
                      <button className="mini-btn danger" onClick={() => removeFamily(i)}>Remove</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {profileTab === 'documents' && (
        <div className="card" style={{ maxWidth: '750px', margin: '0 auto' }}>
          <div className="card-head">
            <div>
              <div className="card-title">Employee Document Library</div>
              <div className="card-sub">Uploaded IDs, certificates, and credentials</div>
            </div>
          </div>
          {myDocs.length === 0 ? (
            <div className="empty">No documents uploaded for this employee.</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Title</th><th>Folder</th><th>Type</th><th>Expiry Date</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {myDocs.map((doc) => (
                    <tr key={doc.id}>
                      <td><strong>{doc.title}</strong></td>
                      <td><span className="state-badge pending">{doc.folder}</span></td>
                      <td><span className="state-badge approved">{doc.type}</span></td>
                      <td className="mono">{doc.expiryDate ? formatDate(doc.expiryDate) : '—'}</td>
                      <td>
                        <button className="mini-btn" onClick={() => openFile(doc)}>Open / Download</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Edit Personal Details Modal */}
      <Modal
        open={editSection === 'personal'}
        title="Edit Personal Information"
        onClose={() => setEditSection(null)}
        width={480}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setEditSection(null)}>Cancel</button>
            <button className="btn" onClick={savePersonal}>Save details</button>
          </>
        )}
      >
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Date of Birth</span>
            <input type="date" className="input" value={personalForm.dob} onChange={(e) => setPersonalForm(prev => ({ ...prev, dob: e.target.value }))} />
          </label>
          <label className="field">
            <span className="field-label">Gender</span>
            <select className="input" value={personalForm.gender} onChange={(e) => setPersonalForm(prev => ({ ...prev, gender: e.target.value }))}>
              <option value="">Choose Gender</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Blood Group</span>
            <input type="text" placeholder="e.g. O+" className="input" value={personalForm.bloodGroup} onChange={(e) => setPersonalForm(prev => ({ ...prev, bloodGroup: e.target.value }))} />
          </label>
          <label className="field">
            <span className="field-label">Phone Contact</span>
            <input type="text" placeholder="+91 …" className="input" value={personalForm.phone} onChange={(e) => setPersonalForm(prev => ({ ...prev, phone: e.target.value }))} />
          </label>
          <label className="field field-full">
            <span className="field-label">Personal Email</span>
            <input type="email" placeholder="name@personal.com" className="input" value={personalForm.personalEmail} onChange={(e) => setPersonalForm(prev => ({ ...prev, personalEmail: e.target.value }))} />
          </label>

          <div style={{ gridColumn: 'span 2', fontWeight: 600, fontSize: 13, borderBottom: '1px solid var(--line)', paddingBottom: 4, marginTop: 12 }}>
            Emergency Contact Details
          </div>
          <label className="field">
            <span className="field-label">Contact Name</span>
            <input type="text" placeholder="e.g. S. K. Sharma" className="input" value={personalForm.emergencyName} onChange={(e) => setPersonalForm(prev => ({ ...prev, emergencyName: e.target.value }))} />
          </label>
          <label className="field">
            <span className="field-label">Relation</span>
            <input type="text" placeholder="e.g. Father" className="input" value={personalForm.emergencyRelation} onChange={(e) => setPersonalForm(prev => ({ ...prev, emergencyRelation: e.target.value }))} />
          </label>
          <label className="field field-full">
            <span className="field-label">Emergency Phone</span>
            <input type="text" placeholder="+91 …" className="input" value={personalForm.emergencyPhone} onChange={(e) => setPersonalForm(prev => ({ ...prev, emergencyPhone: e.target.value }))} />
          </label>
        </div>
      </Modal>

      {/* Edit Bank Details Modal */}
      <Modal
        open={editSection === 'bank'}
        title="Edit Salary Routing Bank Details"
        onClose={() => setEditSection(null)}
        width={440}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setEditSection(null)}>Cancel</button>
            <button className="btn" onClick={saveBank}>Save Details</button>
          </>
        )}
      >
        <div className="form-grid">
          <label className="field field-full">
            <span className="field-label">Bank Name</span>
            <input type="text" placeholder="e.g. HDFC Bank" className="input" value={bankForm.bankName} onChange={(e) => setBankForm(prev => ({ ...prev, bankName: e.target.value }))} />
          </label>
          <label className="field field-full">
            <span className="field-label">Bank Account Number</span>
            <input type="text" placeholder="Account no." className="input mono" value={bankForm.bankAccount} onChange={(e) => setBankForm(prev => ({ ...prev, bankAccount: e.target.value }))} />
          </label>
          <label className="field field-full">
            <span className="field-label">IFSC Code</span>
            <input type="text" placeholder="IFSC" className="input mono" value={bankForm.ifsc} onChange={(e) => setBankForm(prev => ({ ...prev, ifsc: e.target.value }))} />
          </label>
        </div>
      </Modal>

      {/* Add Education Modal */}
      <Modal
        open={editSection === 'education'}
        title="Add Education Record"
        onClose={() => setEditSection(null)}
        width={420}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setEditSection(null)}>Cancel</button>
            <button className="btn approve" disabled={!eduForm.degree || !eduForm.institution} onClick={addEducation}>Add Record</button>
          </>
        )}
      >
        <div className="form-grid">
          <label className="field field-full">
            <span className="field-label">Degree / Qualification</span>
            <input type="text" placeholder="e.g. B.Tech Computer Science" className="input" value={eduForm.degree} onChange={(e) => setEduForm(prev => ({ ...prev, degree: e.target.value }))} />
          </label>
          <label className="field field-full">
            <span className="field-label">Institution / College / School</span>
            <input type="text" placeholder="e.g. IIT Delhi" className="input" value={eduForm.institution} onChange={(e) => setEduForm(prev => ({ ...prev, institution: e.target.value }))} />
          </label>
          <label className="field">
            <span className="field-label">Passing Year</span>
            <input type="text" placeholder="e.g. 2024" className="input mono" value={eduForm.year} onChange={(e) => setEduForm(prev => ({ ...prev, year: e.target.value }))} />
          </label>
          <label className="field">
            <span className="field-label">Grade / Percentage</span>
            <input type="text" placeholder="e.g. 8.5 CGPA" className="input" value={eduForm.grade} onChange={(e) => setEduForm(prev => ({ ...prev, grade: e.target.value }))} />
          </label>
        </div>
      </Modal>

      {/* Add Experience Modal */}
      <Modal
        open={editSection === 'experience'}
        title="Add Work Experience Record"
        onClose={() => setEditSection(null)}
        width={420}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setEditSection(null)}>Cancel</button>
            <button className="btn approve" disabled={!expForm.company || !expForm.role} onClick={addExperience}>Add Record</button>
          </>
        )}
      >
        <div className="form-grid">
          <label className="field field-full">
            <span className="field-label">Company Name</span>
            <input type="text" placeholder="e.g. Google India" className="input" value={expForm.company} onChange={(e) => setExpForm(prev => ({ ...prev, company: e.target.value }))} />
          </label>
          <label className="field field-full">
            <span className="field-label">Role / Position</span>
            <input type="text" placeholder="e.g. Systems Engineer" className="input" value={expForm.role} onChange={(e) => setExpForm(prev => ({ ...prev, role: e.target.value }))} />
          </label>
          <label className="field">
            <span className="field-label">From Date</span>
            <input type="text" placeholder="e.g. June 2022" className="input" value={expForm.from} onChange={(e) => setExpForm(prev => ({ ...prev, from: e.target.value }))} />
          </label>
          <label className="field">
            <span className="field-label">To Date (or Present)</span>
            <input type="text" placeholder="e.g. Dec 2023" className="input" value={expForm.to} onChange={(e) => setExpForm(prev => ({ ...prev, to: e.target.value }))} />
          </label>
        </div>
      </Modal>

      {/* Add Family Member Modal */}
      <Modal
        open={editSection === 'family'}
        title="Add Family Member / Dependent"
        onClose={() => setEditSection(null)}
        width={420}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setEditSection(null)}>Cancel</button>
            <button className="btn approve" disabled={!famForm.name || !famForm.relation} onClick={addFamily}>Add Member</button>
          </>
        )}
      >
        <div className="form-grid">
          <label className="field field-full">
            <span className="field-label">Member Name</span>
            <input type="text" placeholder="Name" className="input" value={famForm.name} onChange={(e) => setFamForm(prev => ({ ...prev, name: e.target.value }))} />
          </label>
          <label className="field field-full">
            <span className="field-label">Relation</span>
            <input type="text" placeholder="e.g. Mother, Spouse, Child" className="input" value={famForm.relation} onChange={(e) => setFamForm(prev => ({ ...prev, relation: e.target.value }))} />
          </label>
          <label className="field field-full">
            <span className="field-label">Phone Contact (optional)</span>
            <input type="text" placeholder="+91 …" className="input mono" value={famForm.phone} onChange={(e) => setFamForm(prev => ({ ...prev, phone: e.target.value }))} />
          </label>
        </div>
      </Modal>
    </div>
  );
}
