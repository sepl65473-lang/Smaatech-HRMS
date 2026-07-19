import { useMemo, useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import Modal from '../components/Modal';
import ConfirmDialog from '../components/ConfirmDialog';
import CsvImportModal from '../components/CsvImportModal';
import { downloadCSV } from '../lib/csv';
import { IconPlus, IconTrash } from '../components/Icons';
import { MONTH_NAMES, parseHolidayDay } from '../lib/helpers';

const TYPES = ['National', 'Regional', 'Optional'];
const TYPE_CLASS = { National: 'tag-earned', Regional: 'tag-casual', Optional: 'tag-sick' };

export default function Holidays() {
  const { holidays, addHoliday, deleteHoliday, importHolidays, toast } = useHRMS();
  const today = new Date();
  const [year] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [formOpen, setFormOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [form, setForm] = useState({ name: '', day: '', month: today.getMonth(), type: 'National' });

  const handleExportCsv = () => {
    const keys = ['name', 'date', 'type'];
    const labels = ['Holiday Name', 'Date', 'Type'];
    downloadCSV(holidays, keys, 'holidays.csv', labels);
    toast('success', 'Holidays calendar exported successfully');
  };

  const byDay = useMemo(() => {
    const map = {};
    holidays.forEach((h) => {
      const parsed = parseHolidayDay(h.date);
      if (parsed && parsed.month === month) {
        (map[parsed.day] = map[parsed.day] || []).push(h);
      }
    });
    return map;
  }, [holidays, month]);

  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const monthList = useMemo(() => holidays
    .map((h) => ({ ...h, parsed: parseHolidayDay(h.date) }))
    .filter((h) => h.parsed?.month === month)
    .sort((a, b) => a.parsed.day - b.parsed.day), [holidays, month]);

  const isToday = (day) => day === today.getDate() && month === today.getMonth();

  const openAdd = () => {
    setForm({ name: '', day: '', month, type: 'National' });
    setFormOpen(true);
  };

  const submit = () => {
    if (!form.name.trim() || !form.day) return;
    const weekday = new Date(year, form.month, Number(form.day)).toLocaleDateString('en-IN', { weekday: 'short' });
    addHoliday({
      name: form.name.trim(),
      date: `${form.day} ${MONTH_NAMES[form.month]}, ${weekday}`,
      type: form.type,
    });
    setFormOpen(false);
  };

  return (
    <div className="page-wrap active">
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Holiday calendar</div>
            <div className="card-sub">{monthList.length} holidays in {MONTH_NAMES[month]} {year}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select className="input" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTH_NAMES.map((m, i) => <option key={m} value={i}>{m} {year}</option>)}
            </select>
            <button className="btn btn-ghost" onClick={handleExportCsv}>Export CSV</button>
            <button className="btn btn-ghost" onClick={() => setImportOpen(true)}>Import CSV</button>
            <button className="btn" onClick={openAdd}><IconPlus width="14" height="14" /> Add holiday</button>
          </div>
        </div>

        <div className="cal-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, marginTop: 16 }}>
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d} style={{ textAlign: 'center', fontSize: 12, color: 'var(--muted)', fontWeight: 600, padding: '4px 0' }}>{d}</div>
          ))}
          {cells.map((day, i) => (
            <div
              key={i}
              style={{
                minHeight: 64,
                borderRadius: 8,
                padding: 6,
                background: day == null ? 'transparent' : isToday(day) ? 'var(--sage-soft)' : 'var(--paper)',
                border: day == null ? 'none' : '1px solid var(--line)',
              }}
            >
              {day != null && (
                <>
                  <div style={{ fontSize: 12, fontWeight: isToday(day) ? 700 : 500 }}>{day}</div>
                  {(byDay[day] || []).map((h) => (
                    <span key={h.id} className={`leave-tag ${TYPE_CLASS[h.type] || 'tag-casual'}`} style={{ display: 'block', marginTop: 4, fontSize: 10 }}>
                      {h.name}
                    </span>
                  ))}
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head">
          <div>
            <div className="card-title">List view</div>
            <div className="card-sub">{MONTH_NAMES[month]} {year}</div>
          </div>
        </div>
        <div className="leave-list">
          {monthList.length === 0 && <div className="empty">No holidays this month.</div>}
          {monthList.map((h) => (
            <div className="leave-item" key={h.id}>
              <div className="leave-body">
                <div className="leave-name">{h.name}</div>
                <div className="leave-meta">{h.date}</div>
                <span className={`leave-tag ${TYPE_CLASS[h.type] || 'tag-casual'}`}>{h.type}</span>
                <div className="leave-actions">
                  <button className="mini-btn danger" onClick={() => setConfirm(h)}>
                    <IconTrash width="12" height="12" /> Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <Modal
        open={formOpen}
        title="Add holiday"
        onClose={() => setFormOpen(false)}
        width={420}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setFormOpen(false)}>Cancel</button>
            <button className="btn" onClick={submit}>Add holiday</button>
          </>
        )}
      >
        <div className="form-grid">
          <label className="field field-full">
            <span className="field-label">Holiday name</span>
            <input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Republic Day" />
          </label>
          <label className="field">
            <span className="field-label">Day</span>
            <input type="number" min="1" max="31" className="input" value={form.day} onChange={(e) => setForm((f) => ({ ...f, day: e.target.value }))} />
          </label>
          <label className="field">
            <span className="field-label">Month</span>
            <select className="input" value={form.month} onChange={(e) => setForm((f) => ({ ...f, month: Number(e.target.value) }))}>
              {MONTH_NAMES.map((m, i) => <option key={m} value={i}>{m}</option>)}
            </select>
          </label>
          <label className="field field-full">
            <span className="field-label">Type</span>
            <select className="input" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
              {TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        title="Remove holiday"
        message={confirm ? `Remove "${confirm.name}" from the calendar?` : ''}
        confirmLabel="Remove"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => { await deleteHoliday(confirm.id); setConfirm(null); }}
      />

      <CsvImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={importHolidays}
        title="Import holidays from CSV"
        subtitle="Bulk add holidays to calendar"
        templateHeader="name,date,type"
        templateSample="Independence Day,15 Aug,National\nChristmas,2026-12-25,National"
        templateFileName="holiday-import-template.csv"
        columns={[
          { key: 'name', label: 'Holiday Name' },
          { key: 'date', label: 'Date' },
          { key: 'type', label: 'Type' },
        ]}
        validateRow={(row) => {
          const errors = [];
          if (!row.name) errors.push('Name is required');
          if (!row.date) errors.push('Date is required');
          return errors;
        }}
        mapRow={(r) => {
          let dateVal = r.date || '';
          if (/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
            const d = new Date(dateVal);
            if (!isNaN(d.getTime())) {
              const day = d.getDate();
              const monthName = MONTH_NAMES[d.getMonth()];
              const weekday = d.toLocaleDateString('en-IN', { weekday: 'short' });
              dateVal = `${day} ${monthName}, ${weekday}`;
            }
          }
          return {
            name: r.name,
            date: dateVal,
            type: r.type || 'National',
          };
        }}
      />
    </div>
  );
}
