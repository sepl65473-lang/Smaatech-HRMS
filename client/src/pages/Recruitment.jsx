import { useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import ConfirmDialog from '../components/ConfirmDialog';
import Modal from '../components/Modal';
import { IconPlus, IconTrash } from '../components/Icons';

const STAGES = ['Applied', 'Screening', 'Interview', 'Offer', 'Hired'];

export default function Recruitment() {
  const {
    recruitment,
    moveCandidate,
    addCandidate,
    deleteCandidate,
    toggleOnboardingItem,
    jobs,
    addJob,
    updateJobStatus,
    employees,
    audit,
    toast
  } = useHRMS();

  // Navigation states
  const [activeTab, setActiveTab] = useState('pipeline'); // 'pipeline' | 'jobs'

  // Pipeline Modals
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ candidate: '', title: '' });
  const [confirm, setConfirm] = useState(null);
  const [onboarding, setOnboarding] = useState(null);

  // Resume Viewer States
  const [selectedResume, setSelectedResume] = useState(null);

  // Interview Scheduler States
  const [schedulerTarget, setSchedulerTarget] = useState(null);
  const [interviewDate, setInterviewDate] = useState('');
  const [interviewTime, setInterviewTime] = useState('11:30 AM');
  const [selectedInterviewer, setSelectedInterviewer] = useState('');
  const [interviewNotes, setInterviewNotes] = useState('');

  // Onboarding Mock Upload target
  const [uploadTarget, setUploadTarget] = useState(null);

  // Exit Interview States
  const [exitTarget, setExitTarget] = useState(null);
  const [exitReason, setExitReason] = useState('New Career Opportunity');
  const [exitFeedback, setExitFeedback] = useState('');

  // Job Openings form modal
  const [jobOpen, setJobOpen] = useState(false);
  const [jobForm, setJobForm] = useState({ title: '', department: 'Engineering', location: 'Bengaluru', type: 'Full-time', description: '' });

  const byStage = (s) => recruitment.filter((c) => c.stage === s);

  const next = (c) => {
    const i = STAGES.indexOf(c.stage);
    if (i < STAGES.length - 1) moveCandidate(c.id, STAGES[i + 1]);
  };
  
  const prev = (c) => {
    const i = STAGES.indexOf(c.stage);
    if (i > 0) moveCandidate(c.id, STAGES[i - 1]);
  };

  const onboardingCandidate = onboarding ? recruitment.find((c) => c.id === onboarding) : null;

  const submit = async () => {
    if (!form.candidate.trim() || !form.title.trim()) return;
    await addCandidate(form);
    setForm({ candidate: '', title: '' });
    setOpen(false);
  };

  const handleAddJob = async () => {
    if (!jobForm.title.trim()) return;
    await addJob(jobForm);
    setJobForm({ title: '', department: 'Engineering', location: 'Bengaluru', type: 'Full-time', description: '' });
    setJobOpen(false);
  };

  const handleScheduleSave = async () => {
    if (!schedulerTarget) return;
    const metaStr = `Interview: ${interviewDate} at ${interviewTime} with ${selectedInterviewer}`;
    await moveCandidate(schedulerTarget.id, 'Interview', { meta: metaStr });
    setSchedulerTarget(null);
    setInterviewDate('');
    setSelectedInterviewer('');
    setInterviewNotes('');
  };

  return (
    <div className="page-wrap active">
      {/* Tab bar header */}
      <div style={{ display: 'flex', gap: 16, borderBottom: '1px solid #eee', padding: '12px 24px', background: 'var(--paper)', borderRadius: '8px 8px 0 0' }}>
        <button 
          className={`btn ${activeTab === 'pipeline' ? '' : 'btn-ghost'}`} 
          onClick={() => setActiveTab('pipeline')}
          style={{ padding: '6px 16px', fontSize: 13, border: 'none', cursor: 'pointer' }}
        >
          Hiring Pipeline
        </button>
        <button 
          className={`btn ${activeTab === 'jobs' ? '' : 'btn-ghost'}`} 
          onClick={() => setActiveTab('jobs')}
          style={{ padding: '6px 16px', fontSize: 13, border: 'none', cursor: 'pointer' }}
        >
          Job Openings ({jobs.length})
        </button>
      </div>

      {activeTab === 'pipeline' ? (
        <div className="card" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
          <div className="card-head">
            <div>
              <div className="card-title">Hiring pipeline</div>
              <div className="card-sub">{recruitment.length} candidates across {STAGES.length} stages</div>
            </div>
            <button className="btn" onClick={() => setOpen(true)}><IconPlus width="14" height="14" /> Add candidate</button>
          </div>

          <div className="kanban">
            {STAGES.map((s) => (
              <div className="kanban-col" key={s}>
                <div className="kanban-col-head"><span>{s}</span><span className="count">{byStage(s).length}</span></div>
                {byStage(s).map((c) => (
                  <div className="kanban-card" key={c.id}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div className="kanban-card-title">{c.title}</div>
                      <button 
                        className="mini-btn" 
                        style={{ fontSize: 10, padding: '1px 4px', textTransform: 'uppercase' }}
                        onClick={() => setSelectedResume(c)}
                      >
                        Resume
                      </button>
                    </div>
                    <div className="kanban-card-meta">
                      <span style={{ fontWeight: 600 }}>{c.candidate}</span>
                    </div>
                    <div className="kanban-card-meta" style={{ marginTop: 2 }}>
                      <span style={{ fontStyle: 'italic', fontSize: 11 }}>{c.meta}</span>
                    </div>

                    <div className="kanban-card-actions" style={{ marginTop: 12 }}>
                      <button className="mini-btn" disabled={c.stage === STAGES[0]} onClick={() => prev(c)}>Back</button>
                      
                      {c.stage === 'Interview' && (
                        <button className="mini-btn" onClick={() => setSchedulerTarget(c)}>
                          Schedule
                        </button>
                      )}

                      {c.stage === 'Hired' ? (
                        <button className="mini-btn approve" onClick={() => setOnboarding(c.id)}>Checklist</button>
                      ) : (
                        <button className="mini-btn approve" disabled={c.stage === STAGES[STAGES.length - 1]} onClick={() => next(c)}>Next</button>
                      )}
                      
                      <button className="icon-btn sm danger" title="Remove" onClick={() => setConfirm(c)}>
                        <IconTrash width="13" height="13" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* Jobs Tab list layout */
        <div className="card" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
          <div className="card-head">
            <div>
              <div className="card-title">Active Job Openings</div>
              <div className="card-sub">Manage job listings and track application status</div>
            </div>
            <button className="btn" onClick={() => setJobOpen(true)}>
              <IconPlus width="14" height="14" /> Create Job Posting
            </button>
          </div>

          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Job Title</th>
                  <th>Department</th>
                  <th>Location</th>
                  <th>Job Type</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td><strong>{job.title}</strong></td>
                    <td>{job.department}</td>
                    <td>{job.location}</td>
                    <td><span className="state-badge approved" style={{ textTransform: 'none' }}>{job.type}</span></td>
                    <td>
                      <span className={`state-badge ${job.status === 'Open' ? 'approved' : 'declined'}`}>
                        {job.status}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {job.status === 'Open' ? (
                        <button 
                          className="mini-btn"
                          onClick={async () => { await updateJobStatus(job.id, 'Closed'); }}
                        >
                          Close Posting
                        </button>
                      ) : (
                        <button 
                          className="mini-btn approve"
                          onClick={async () => { await updateJobStatus(job.id, 'Open'); }}
                        >
                          Reopen Posting
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal - Add candidate */}
      <Modal
        open={open}
        title="Add candidate"
        subtitle="New entry in the pipeline"
        onClose={() => setOpen(false)}
        width={440}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn" onClick={submit}>Add candidate</button>
          </>
        )}
      >
        <div className="form-grid">
          <label className="field field-full">
            <span className="field-label">Candidate name</span>
            <input className="input" value={form.candidate} onChange={(e) => setForm((f) => ({ ...f, candidate: e.target.value }))} placeholder="e.g. Riya Mehta" />
          </label>
          <label className="field field-full">
            <span className="field-label">Role</span>
            <input className="input" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Backend Engineer" />
          </label>
        </div>
      </Modal>

      {/* Modal - Create Job Posting */}
      <Modal
        open={jobOpen}
        title="Create Job Posting"
        subtitle="Post a new opening for candidate applications"
        onClose={() => setJobOpen(false)}
        width={440}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setJobOpen(false)}>Cancel</button>
            <button className="btn approve" disabled={!jobForm.title} onClick={handleAddJob}>Publish Job</button>
          </>
        )}
      >
        <div className="form-grid">
          <label className="field field-full">
            <span className="field-label">Job Title</span>
            <input 
              className="input" 
              value={jobForm.title} 
              onChange={(e) => setJobForm(prev => ({ ...prev, title: e.target.value }))} 
              placeholder="e.g. Senior Frontend Engineer" 
            />
          </label>
          <label className="field">
            <span className="field-label">Department</span>
            <select 
              className="input" 
              value={jobForm.department} 
              onChange={(e) => setJobForm(prev => ({ ...prev, department: e.target.value }))}
            >
              <option value="Engineering">Engineering</option>
              <option value="Design">Design</option>
              <option value="Sales">Sales</option>
              <option value="Marketing">Marketing</option>
              <option value="HR">HR</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Job Type</span>
            <select 
              className="input" 
              value={jobForm.type} 
              onChange={(e) => setJobForm(prev => ({ ...prev, type: e.target.value }))}
            >
              <option value="Full-time">Full-time</option>
              <option value="Part-time">Part-time</option>
              <option value="Contract">Contract</option>
              <option value="Internship">Internship</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Location</span>
            <input 
              className="input" 
              value={jobForm.location} 
              onChange={(e) => setJobForm(prev => ({ ...prev, location: e.target.value }))} 
              placeholder="e.g. Bengaluru" 
            />
          </label>
          <label className="field field-full">
            <span className="field-label">Brief Description</span>
            <textarea 
              className="input" 
              rows={3} 
              value={jobForm.description} 
              onChange={(e) => setJobForm(prev => ({ ...prev, description: e.target.value }))} 
              placeholder="Key requirements and skills..." 
            />
          </label>
        </div>
      </Modal>

      {/* Modal - Resume Viewer */}
      <Modal
        open={Boolean(selectedResume)}
        title="Candidate Resume Profile"
        subtitle={selectedResume ? `${selectedResume.candidate} · Applicant Details` : ''}
        onClose={() => setSelectedResume(null)}
        width={450}
        footer={<button className="btn" onClick={() => setSelectedResume(null)}>Close Profile</button>}
      >
        {selectedResume && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <h4 style={{ margin: '0 0 4px 0', fontSize: 11, textTransform: 'uppercase', color: '#888', letterSpacing: '0.5px' }}>Applied Position</h4>
              <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>{selectedResume.title}</p>
            </div>
            <div>
              <h4 style={{ margin: '0 0 4px 0', fontSize: 11, textTransform: 'uppercase', color: '#888', letterSpacing: '0.5px' }}>Education Background</h4>
              <p style={{ margin: 0, fontSize: 13 }}>B.Tech in Computer Science & Engineering (2024)</p>
            </div>
            <div>
              <h4 style={{ margin: '0 0 4px 0', fontSize: 11, textTransform: 'uppercase', color: '#888', letterSpacing: '0.5px' }}>Past Employment / Experience</h4>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
                Intern Software Developer at Smaatech Solutions (6 months)<br />
                Technical Projects Lead in open-source libraries.
              </p>
            </div>
            <div>
              <h4 style={{ margin: '0 0 4px 0', fontSize: 11, textTransform: 'uppercase', color: '#888', letterSpacing: '0.5px' }}>Skills Inventory</h4>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                {['React.js', 'Node.js', 'JavaScript', 'SQL Database', 'REST APIs', 'Git'].map(s => (
                  <span key={s} className="chip active" style={{ fontSize: '11px', padding: '2px 6px', margin: 0 }}>{s}</span>
                ))}
              </div>
            </div>
            <div style={{ borderTop: '1px solid #eee', paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="muted-text" style={{ fontSize: '12px' }}>Attachment: resume-cv.pdf</span>
              <button 
                className="mini-btn approve" 
                onClick={() => {
                  toast('info', 'Resume file downloaded in background (Simulated)');
                  audit('Resume Downloaded', selectedResume.candidate);
                }}
              >
                Download PDF
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Modal - Interview Scheduler */}
      <Modal
        open={Boolean(schedulerTarget)}
        title="Schedule Interview Session"
        subtitle={schedulerTarget ? `Scheduling interview for ${schedulerTarget.candidate}` : ''}
        onClose={() => setSchedulerTarget(null)}
        width={420}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setSchedulerTarget(null)}>Cancel</button>
            <button className="btn approve" disabled={!interviewDate || !selectedInterviewer} onClick={handleScheduleSave}>Save Schedule</button>
          </>
        )}
      >
        <div className="form-grid">
          <label className="field field-full">
            <span className="field-label">Select Date</span>
            <input type="date" className="input mono" value={interviewDate} onChange={(e) => setInterviewDate(e.target.value)} />
          </label>
          <label className="field field-full">
            <span className="field-label">Time Slot</span>
            <input type="text" className="input" placeholder="e.g. 11:30 AM" value={interviewTime} onChange={(e) => setInterviewTime(e.target.value)} />
          </label>
          <label className="field field-full">
            <span className="field-label">Interviewer / Panelist</span>
            <select className="input" value={selectedInterviewer} onChange={(e) => setSelectedInterviewer(e.target.value)}>
              <option value="">-- Choose Panelist --</option>
              {employees.map((e) => (
                <option key={e.id} value={e.name}>{e.name} ({e.role})</option>
              ))}
            </select>
          </label>
          <label className="field field-full">
            <span className="field-label">Interviewer Notes</span>
            <input type="text" className="input" placeholder="Topics to cover..." value={interviewNotes} onChange={(e) => setInterviewNotes(e.target.value)} />
          </label>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        title="Remove candidate"
        message={confirm ? `Remove ${confirm.candidate} from the hiring pipeline?` : ''}
        confirmLabel="Remove"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => { await deleteCandidate(confirm.id); setConfirm(null); }}
      />

      {/* Onboarding Checklist Modal */}
      <Modal
        open={Boolean(onboardingCandidate)}
        title="Onboarding & Offboarding Checklist"
        subtitle={onboardingCandidate ? `${onboardingCandidate.candidate} · ${onboardingCandidate.title}` : ''}
        onClose={() => setOnboarding(null)}
        width={460}
        footer={<button className="btn" onClick={() => setOnboarding(null)}>Done</button>}
      >
        <div className="settings-rows">
          {(onboardingCandidate?.onboarding || []).map((item) => (
            <button
              key={item.id}
              className="settings-row"
              style={{ width: '100%', textAlign: 'left', border: 'none', background: 'none', cursor: 'pointer' }}
              onClick={() => {
                if (item.id === 'ob_0' && !item.done) {
                  // Simulate document upload first
                  setUploadTarget(item.id);
                } else if (item.id === 'ob_5' && !item.done) {
                  // Trigger Exit Interview Form
                  setExitTarget(onboardingCandidate);
                } else {
                  toggleOnboardingItem(onboardingCandidate.id, item.id);
                }
              }}
            >
              <div className="settings-row-label" style={{ textDecoration: item.done ? 'line-through' : 'none', opacity: item.done ? 0.6 : 1 }}>
                {item.id === 'ob_0' ? '📄 Verify documents (Click to upload)' : item.id === 'ob_5' ? '👋 Exit Interview (Click to file form)' : item.label}
              </div>
              <span className={`toggle ${item.done ? 'on' : ''}`} aria-hidden="true" />
            </button>
          ))}
        </div>
      </Modal>

      {/* Mock Document Upload Modal */}
      <Modal
        open={Boolean(uploadTarget)}
        title="Verify Identity Documents"
        subtitle="Upload scan copy of National ID / Passport"
        onClose={() => setUploadTarget(null)}
        width={380}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setUploadTarget(null)}>Cancel</button>
            <button className="btn approve" onClick={() => {
              toggleOnboardingItem(onboardingCandidate.id, uploadTarget);
              setUploadTarget(null);
              toast('success', 'Documents uploaded & verified successfully!');
              audit('Document Uploaded', onboardingCandidate.candidate, 'Passport/ID verification completed.');
            }}>Simulate Upload</button>
          </>
        )}
      >
        <div style={{ padding: 24, border: '2px dashed #ccc', borderRadius: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, background: '#f8f9fa' }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Drag files here or click to browse</span>
          <span style={{ fontSize: 11, color: '#888' }}>Supports PDF, JPG, PNG up to 10MB</span>
        </div>
      </Modal>

      {/* Exit Interview Modal */}
      <Modal
        open={Boolean(exitTarget)}
        title="Exit Interview Questionnaire"
        subtitle={`Offboarding Exit Checks for ${exitTarget?.candidate}`}
        onClose={() => setExitTarget(null)}
        width={420}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setExitTarget(null)}>Cancel</button>
            <button 
              className="btn danger" 
              onClick={() => {
                toggleOnboardingItem(exitTarget.id, 'ob_5');
                audit('Exit Interview Filed', exitTarget.candidate, `Reason: ${exitReason} - Feedback: ${exitFeedback}`);
                toast('info', `Exit feedback recorded for ${exitTarget.candidate}`);
                setExitTarget(null);
              }}
            >
              File Exit Records
            </button>
          </>
        )}
      >
        <div className="form-grid">
          <label className="field field-full">
            <span className="field-label">Primary Reason for Exit</span>
            <select className="input" value={exitReason} onChange={(e) => setExitReason(e.target.value)}>
              <option value="New Career Opportunity">New Career Opportunity</option>
              <option value="Health or Personal issues">Health or Personal issues</option>
              <option value="Relocation">Relocation</option>
              <option value="Work Environment">Work Environment</option>
            </select>
          </label>
          <label className="field field-full">
            <span className="field-label">Detailed Feedback & Notes</span>
            <textarea
              className="input"
              rows={3}
              placeholder="What could we have done better?"
              value={exitFeedback}
              onChange={(e) => setExitFeedback(e.target.value)}
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}
