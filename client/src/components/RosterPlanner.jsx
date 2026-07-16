import { useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import { DEFAULT_SHIFTS } from '../lib/shifts';
import { canDo } from '../lib/permissions';
import { IconPlus, IconTrash } from './Icons';

const WEEKDAYS = [
  { key: 'mon', label: 'Mon' }, { key: 'tue', label: 'Tue' }, { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' }, { key: 'fri', label: 'Fri' }, { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
];

let shiftSeq = 0;
const newShiftId = () => `shift_custom_${Date.now()}_${shiftSeq++}`;

export default function RosterPlanner() {
  const { employees, settings, updateSettings, currentUser } = useHRMS();
  const canEdit = canDo(currentUser.role, 'manageAttendance');
  const shifts = settings.shifts?.length ? settings.shifts : DEFAULT_SHIFTS;
  const employeeShifts = settings.employeeShifts || {};
  const roster = settings.roster || {};

  const [draft, setDraft] = useState({ name: '', start: '09:00', end: '18:00', graceMins: 15 });

  const saveShifts = (next) => updateSettings({ shifts: next }, false);

  const addShift = () => {
    if (!draft.name.trim()) return;
    saveShifts([...shifts, { id: newShiftId(), ...draft, name: draft.name.trim() }]);
    setDraft({ name: '', start: '09:00', end: '18:00', graceMins: 15 });
  };

  const removeShift = (id) => {
    if (shifts.length <= 1) return;
    saveShifts(shifts.filter((s) => s.id !== id));
  };

  const defaultShiftFor = (empId) => employeeShifts[empId] || shifts[0].id;

  const setDefaultShift = (empId, shiftId) => {
    updateSettings({ employeeShifts: { ...employeeShifts, [empId]: shiftId } }, false);
  };

  const setRosterCell = (empId, day, shiftId) => {
    const empRoster = { ...(roster[empId] || {}), [day]: shiftId };
    updateSettings({ roster: { ...roster, [empId]: empRoster } }, false);
  };

  const applyToWeek = (empId) => {
    const shiftId = defaultShiftFor(empId);
    const empRoster = {};
    WEEKDAYS.forEach((d) => { empRoster[d.key] = shiftId; });
    updateSettings({ roster: { ...roster, [empId]: empRoster } }, false);
  };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Shift types</div>
            <div className="card-sub">Define the shifts employees can be rostered onto</div>
          </div>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th><th>Start</th><th>End</th><th>Grace (mins)</th>
                {canEdit && <th style={{ textAlign: 'right' }}>Action</th>}
              </tr>
            </thead>
            <tbody>
              {shifts.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="mono">{s.start}</td>
                  <td className="mono">{s.end}</td>
                  <td className="mono">{s.graceMins}</td>
                  {canEdit && (
                    <td style={{ textAlign: 'right' }}>
                      <button className="icon-btn sm danger" title="Remove" disabled={shifts.length <= 1} onClick={() => removeShift(s.id)}>
                        <IconTrash width="14" height="14" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canEdit && (
          <div className="form-grid" style={{ marginTop: 12 }}>
            <label className="field">
              <span className="field-label">Name</span>
              <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Weekend" />
            </label>
            <label className="field">
              <span className="field-label">Start</span>
              <input type="time" className="input" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">End</span>
              <input type="time" className="input" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Grace (mins)</span>
              <input type="number" min="0" className="input" value={draft.graceMins} onChange={(e) => setDraft({ ...draft, graceMins: Number(e.target.value) || 0 })} />
            </label>
            <div className="field field-full">
              <button className="btn" onClick={addShift}><IconPlus width="14" height="14" /> Add shift</button>
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Weekly roster</div>
            <div className="card-sub">Assign a shift per employee per day — this is what decides present vs. late</div>
          </div>
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Default shift</th>
                {WEEKDAYS.map((d) => <th key={d.key}>{d.label}</th>)}
                {canEdit && <th></th>}
              </tr>
            </thead>
            <tbody>
              {employees.map((emp) => (
                <tr key={emp.id}>
                  <td>{emp.name}</td>
                  <td>
                    <select
                      className="input compact"
                      disabled={!canEdit}
                      value={defaultShiftFor(emp.id)}
                      onChange={(e) => setDefaultShift(emp.id, e.target.value)}
                    >
                      {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </td>
                  {WEEKDAYS.map((d) => (
                    <td key={d.key}>
                      <select
                        className="input compact"
                        disabled={!canEdit}
                        value={roster[emp.id]?.[d.key] || defaultShiftFor(emp.id)}
                        onChange={(e) => setRosterCell(emp.id, d.key, e.target.value)}
                      >
                        {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </td>
                  ))}
                  {canEdit && (
                    <td>
                      <button className="mini-btn" onClick={() => applyToWeek(emp.id)}>Copy default → week</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
