import { useMemo, useState } from 'react';
import { useHRMS } from '../context/HRMSContext';
import Modal from '../components/Modal';

export default function Assets() {
  const { assets, employees, addAsset, assignAsset, returnAsset } = useHRMS();
  
  // Local state
  const [searchQuery, setSearchQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [newAsset, setNewAsset] = useState({ name: '', category: 'Laptop', serialNumber: '' });
  
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignTarget, setAssignTarget] = useState(null); // Asset row to assign
  const [selectedEmpId, setSelectedEmpId] = useState('');
  const [assignDate, setAssignDate] = useState(() => new Date().toISOString().slice(0, 10));

  // Filtered assets by search query
  const filteredAssets = useMemo(() => {
    return assets.filter((a) => {
      const q = searchQuery.toLowerCase().trim();
      return (
        a.name.toLowerCase().includes(q) ||
        a.serialNumber.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q) ||
        (a.assignedToEmpName && a.assignedToEmpName.toLowerCase().includes(q))
      );
    });
  }, [assets, searchQuery]);

  const handleAddAsset = async () => {
    if (!newAsset.name.trim() || !newAsset.serialNumber.trim()) return;
    await addAsset(newAsset);
    setNewAsset({ name: '', category: 'Laptop', serialNumber: '' });
    setAddOpen(false);
  };

  const handleAssignAsset = async () => {
    if (!assignTarget || !selectedEmpId) return;
    const emp = employees.find((e) => e.id === selectedEmpId);
    if (emp) {
      await assignAsset(assignTarget.id, emp.id, emp.name, assignDate);
    }
    setAssignTarget(null);
    setSelectedEmpId('');
    setAssignOpen(false);
  };

  return (
    <div className="page-wrap active">
      {/* Summary statistics */}
      <div className="stats">
        <div className="stat">
          <div className="stat-label">Total Assets</div>
          <div className="stat-value">{assets.length}</div>
          <div className="stat-meta">devices registered</div>
        </div>
        <div className="stat">
          <div className="stat-label">Assigned</div>
          <div className="stat-value" style={{ color: 'var(--red)' }}>
            {assets.filter((a) => a.status === 'assigned').length}
          </div>
          <div className="stat-meta">in active use</div>
        </div>
        <div className="stat">
          <div className="stat-label">Available</div>
          <div className="stat-value" style={{ color: '#198754' }}>
            {assets.filter((a) => a.status === 'available').length}
          </div>
          <div className="stat-meta">in storage buffer</div>
        </div>
      </div>

      {/* Main card */}
      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="card-title">Assets Inventory</div>
            <div className="card-sub">Manage company hardware, assignments, & return status</div>
          </div>
          <button className="btn" onClick={() => setAddOpen(true)}>
            Add Asset
          </button>
        </div>

        {/* Search and Toolbar */}
        <div className="list-toolbar" style={{ borderBottom: '1px solid #eee', paddingBottom: 12 }}>
          <label className="field" style={{ flex: 1, margin: 0 }}>
            <input 
              type="text" 
              className="input" 
              placeholder="Search assets by name, serial number, category, or owner..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </label>
        </div>

        {filteredAssets.length === 0 ? (
          <div className="empty">No assets matched your search query.</div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Asset Name</th>
                  <th>Category</th>
                  <th>Serial Number</th>
                  <th>Status</th>
                  <th>Assigned Owner</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredAssets.map((asset) => (
                  <tr key={asset.id}>
                    <td><strong>{asset.name}</strong></td>
                    <td><span className="state-badge approved" style={{ textTransform: 'none' }}>{asset.category}</span></td>
                    <td className="mono" style={{ fontSize: '12.5px' }}>{asset.serialNumber}</td>
                    <td>
                      <span className={`state-badge ${asset.status === 'available' ? 'approved' : 'declined'}`}>
                        {asset.status === 'available' ? 'Available' : 'Assigned'}
                      </span>
                    </td>
                    <td>
                      {asset.status === 'assigned' ? (
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontWeight: 600 }}>{asset.assignedToEmpName}</span>
                          <span className="muted-text" style={{ fontSize: '11px' }}>Assigned: {asset.assignedDate}</span>
                        </div>
                      ) : (
                        <span className="muted-text">—</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {asset.status === 'available' ? (
                        <button 
                          className="mini-btn approve"
                          onClick={() => { setAssignTarget(asset); setAssignOpen(true); }}
                        >
                          Assign Device
                        </button>
                      ) : (
                        <button 
                          className="mini-btn"
                          onClick={async () => { await returnAsset(asset.id); }}
                        >
                          Mark Returned
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal - Add Asset */}
      <Modal
        open={addOpen}
        title="Add New Asset"
        subtitle="Register new hardware device into workspace inventory"
        onClose={() => setAddOpen(false)}
        width={400}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setAddOpen(false)}>Cancel</button>
            <button className="btn" disabled={!newAsset.name || !newAsset.serialNumber} onClick={handleAddAsset}>Add Asset</button>
          </>
        )}
      >
        <div className="form-grid">
          <label className="field field-full">
            <span className="field-label">Asset Name</span>
            <input 
              type="text" 
              className="input" 
              placeholder="e.g. MacBook Pro M3 Max"
              value={newAsset.name}
              onChange={(e) => setNewAsset(prev => ({ ...prev, name: e.target.value }))}
            />
          </label>
          <label className="field field-full">
            <span className="field-label">Category</span>
            <select 
              className="input" 
              value={newAsset.category}
              onChange={(e) => setNewAsset(prev => ({ ...prev, category: e.target.value }))}
            >
              <option value="Laptop">Laptop</option>
              <option value="Monitor">Monitor</option>
              <option value="Mobile">Mobile</option>
              <option value="Furniture">Furniture</option>
              <option value="Others">Others</option>
            </select>
          </label>
          <label className="field field-full">
            <span className="field-label">Serial Number</span>
            <input 
              type="text" 
              className="input mono" 
              placeholder="e.g. MBP-SN-xxxx"
              value={newAsset.serialNumber}
              onChange={(e) => setNewAsset(prev => ({ ...prev, serialNumber: e.target.value }))}
            />
          </label>
        </div>
      </Modal>

      {/* Modal - Assign Asset */}
      <Modal
        open={assignOpen}
        title="Assign Hardware Asset"
        subtitle={assignTarget ? `Assigning ${assignTarget.name} (${assignTarget.serialNumber})` : ''}
        onClose={() => setAssignOpen(false)}
        width={420}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setAssignOpen(false)}>Cancel</button>
            <button className="btn approve" disabled={!selectedEmpId} onClick={handleAssignAsset}>Assign Asset</button>
          </>
        )}
      >
        <div className="form-grid">
          <label className="field field-full">
            <span className="field-label">Select Employee</span>
            <select 
              className="input"
              value={selectedEmpId}
              onChange={(e) => setSelectedEmpId(e.target.value)}
            >
              <option value="">-- Choose Employee --</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.name} ({e.role})</option>
              ))}
            </select>
          </label>
          <label className="field field-full">
            <span className="field-label">Assignment Date</span>
            <input 
              type="date" 
              className="input mono" 
              value={assignDate}
              onChange={(e) => setAssignDate(e.target.value)}
            />
          </label>
        </div>
      </Modal>
    </div>
  );
}
