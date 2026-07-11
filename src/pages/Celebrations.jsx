import { useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import Modal from '../components/Modal';
import { IconCheck } from '../components/Icons';
import { initials, gradientFor } from '../lib/helpers';

const QUICK = {
  birthday: ['Happy birthday! 🎉', 'Have an amazing day!', 'Wishing you the best 🎂'],
  anniv: ['Congrats on the milestone! ✦', 'Thank you for your years here!', 'Here’s to many more!'],
};

export default function Celebrations() {
  const { celebrations, holidays, settings, sendWish } = useHRMS();
  const [active, setActive] = useState(null);
  const [msg, setMsg] = useState('');

  const open = (c) => { setActive(c); setMsg(''); };
  const send = async () => { await sendWish(active.id, msg); setActive(null); };

  return (
    <div className="page-wrap active">
      <div className="stats">
        <div className="stat"><div className="stat-label">This week</div><div className="stat-value">{celebrations.length}</div><div className="stat-meta">celebrations</div></div>
        <div className="stat"><div className="stat-label">Wishes sent</div><div className="stat-value">{settings.wishesSent || 0}</div><div className="stat-meta">by you this month</div></div>
        <div className="stat"><div className="stat-label">Birthdays</div><div className="stat-value">{celebrations.filter((c) => c.type === 'birthday').length}</div><div className="stat-meta">coming up</div></div>
        <div className="stat"><div className="stat-label">Anniversaries</div><div className="stat-value">{celebrations.filter((c) => c.type === 'anniv').length}</div><div className="stat-meta">work milestones</div></div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="card-head">
            <div><div className="card-title">All celebrations</div><div className="card-sub">Send a wish in one tap</div></div>
          </div>
          <div>
            {celebrations.map((c) => (
              <div className="birthday-item" key={c.id}>
                <div className="cake-icon">{c.type === 'birthday' ? '🎂' : '✦'}</div>
                <div className="b-body">
                  <div className="b-name">{c.name}</div>
                  <div className="b-date">{c.detail}</div>
                </div>
                <button
                  className={`wish-btn ${c.wished ? 'wished' : ''}`}
                  onClick={() => (c.wished ? null : open(c))}
                >
                  {c.wished ? <><IconCheck width="11" height="11" /> Wished</> : 'Wish →'}
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div><div className="card-title">Holiday calendar</div><div className="card-sub">Upcoming company holidays</div></div>
          </div>
          <div>
            {holidays.map((h) => (
              <div className="birthday-item" key={h.id}>
                <div className="cake-icon">🎊</div>
                <div className="b-body">
                  <div className="b-name">{h.name}</div>
                  <div className="b-date">{h.date} · {h.type}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <Modal
        open={Boolean(active)}
        title="Send wishes"
        subtitle={active ? active.detail : ''}
        onClose={() => setActive(null)}
        width={440}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setActive(null)}>Cancel</button>
            <button className="btn" onClick={send}>Send wish</button>
          </>
        )}
      >
        {active && (
          <>
            <div className="modal-head" style={{ marginBottom: 14 }}>
              <div className="modal-avatar" style={{ background: gradientFor(active.name) }}>
                {initials(active.name)}
              </div>
              <div>
                <div className="b-name" style={{ fontSize: 15 }}>{active.name}</div>
                <div className="modal-sub">{active.detail}</div>
              </div>
            </div>
            <textarea
              className="input"
              rows={3}
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              placeholder="Write a message…"
            />
            <div className="quick-wishes">
              {(QUICK[active.type] || []).map((q) => (
                <button key={q} className="quick-wish" onClick={() => setMsg(q)}>{q}</button>
              ))}
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
