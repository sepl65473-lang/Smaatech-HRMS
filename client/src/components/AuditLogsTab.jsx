import React, { useState, useEffect, useCallback } from 'react';
import { Search, Calendar, RefreshCw, Shield, Download, ChevronLeft, ChevronRight, Filter } from 'lucide-react';
import { auditLogsApi } from '../data/store';

export default function AuditLogsTab() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(15);
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await auditLogsApi.search({
        page,
        limit,
        search: search.trim() || undefined,
        from: from || undefined,
        to: to || undefined,
      });
      if (res && Array.isArray(res.rows)) {
        setLogs(res.rows);
        setTotal(res.total || res.rows.length);
      } else if (Array.isArray(res)) {
        setLogs(res);
        setTotal(res.length);
      } else {
        setLogs([]);
        setTotal(0);
      }
    } catch (err) {
      console.error('Failed to fetch audit logs:', err);
      setError('Failed to load audit logs. Make sure you have HR Director permissions.');
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [page, limit, search, from, to]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setPage(1);
    fetchLogs();
  };

  const handleResetFilters = () => {
    setSearch('');
    setFrom('');
    setTo('');
    setPage(1);
  };

  const exportCsv = () => {
    if (!logs.length) return;
    const headers = ['Timestamp', 'Actor Name', 'Actor Role', 'Action', 'Subject', 'Details', 'IP Address'];
    const csvRows = logs.map((log) => [
      `"${new Date(log.createdAt).toLocaleString()}"`,
      `"${log.actor?.name || 'System'}"`,
      `"${log.actor?.role || '-'}"`,
      `"${log.action || ''}"`,
      `"${(log.subject || '').replace(/"/g, '""')}"`,
      `"${(log.details || '').replace(/"/g, '""')}"`,
      `"${log.ip || '-'}"`,
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...csvRows.map((r) => r.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `Audit_Logs_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const totalPages = Math.max(1, Math.ceil(total / limit));

  const getActionBadgeColor = (action = '') => {
    const act = action.toLowerCase();
    if (act.includes('delete') || act.includes('remove') || act.includes('deactivate')) {
      return 'bg-red-500/10 text-red-400 border-red-500/20';
    }
    if (act.includes('create') || act.includes('add') || act.includes('import') || act.includes('enroll')) {
      return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
    }
    if (act.includes('update') || act.includes('edit') || act.includes('sign') || act.includes('approve')) {
      return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
    }
    return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
  };

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900/60 p-5 rounded-xl border border-slate-800">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Shield className="w-5 h-5 text-indigo-400" /> Audit Trail & System Activity
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Real-time security log tracking administrative changes, financial actions, and user activities.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={fetchLogs}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
            title="Refresh logs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <button
            onClick={exportCsv}
            disabled={!logs.length}
            className="flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <form onSubmit={handleSearchSubmit} className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 bg-slate-900/40 p-4 rounded-xl border border-slate-800/80">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
          <input
            type="text"
            placeholder="Search action, user, or details..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div className="relative">
          <Calendar className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
          <input
            type="date"
            placeholder="From Date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div className="relative">
          <Calendar className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
          <input
            type="date"
            placeholder="To Date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            className="flex-1 py-2 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition flex items-center justify-center gap-1"
          >
            <Filter className="w-3.5 h-3.5" /> Filter
          </button>
          <button
            type="button"
            onClick={handleResetFilters}
            className="px-3 py-2 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
          >
            Reset
          </button>
        </div>
      </form>

      {/* Error Notice */}
      {error && (
        <div className="p-4 bg-red-950/40 border border-red-800/50 rounded-xl text-red-400 text-xs flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-300 font-bold hover:underline">Dismiss</button>
        </div>
      )}

      {/* Logs Table */}
      <div className="bg-slate-900/60 rounded-xl border border-slate-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950/80 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">Timestamp</th>
                <th className="py-3 px-4">Actor</th>
                <th className="py-3 px-4">Action</th>
                <th className="py-3 px-4">Subject / Entity</th>
                <th className="py-3 px-4">Details</th>
                <th className="py-3 px-4">IP Address</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {loading ? (
                Array.from({ length: 5 }).map((_, idx) => (
                  <tr key={idx} className="animate-pulse">
                    <td className="py-3 px-4"><div className="h-4 bg-slate-800 rounded w-24"></div></td>
                    <td className="py-3 px-4"><div className="h-4 bg-slate-800 rounded w-28"></div></td>
                    <td className="py-3 px-4"><div className="h-4 bg-slate-800 rounded w-32"></div></td>
                    <td className="py-3 px-4"><div className="h-4 bg-slate-800 rounded w-20"></div></td>
                    <td className="py-3 px-4"><div className="h-4 bg-slate-800 rounded w-40"></div></td>
                    <td className="py-3 px-4"><div className="h-4 bg-slate-800 rounded w-20"></div></td>
                  </tr>
                ))
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan="6" className="py-8 text-center text-slate-500">
                    No audit log records found matching your filters.
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log._id || log.id || `${log.createdAt}-${Math.random()}`} className="hover:bg-slate-800/40 transition">
                    <td className="py-3 px-4 whitespace-nowrap text-slate-400 font-mono text-[11px]">
                      {new Date(log.createdAt).toLocaleString(undefined, {
                        month: 'short',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-200">{log.actor?.name || 'System'}</div>
                      <div className="text-[10px] text-slate-400">{log.actor?.role || 'Automation'}</div>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`inline-block px-2.5 py-1 text-[11px] font-medium rounded-md border ${getActionBadgeColor(log.action)}`}>
                        {log.action}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-300 font-medium max-w-[150px] truncate" title={log.subject}>
                      {log.subject || '-'}
                    </td>
                    <td className="py-3 px-4 text-slate-400 max-w-[220px] truncate" title={log.details}>
                      {log.details || '-'}
                    </td>
                    <td className="py-3 px-4 text-slate-400 font-mono text-[11px]">
                      {log.ip || '127.0.0.1'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer Pagination */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-4 bg-slate-950/80 border-t border-slate-800 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span>Show</span>
            <select
              value={limit}
              onChange={(e) => {
                setLimit(Number(e.target.value));
                setPage(1);
              }}
              className="bg-slate-900 border border-slate-800 text-slate-200 rounded px-2 py-1 focus:outline-none"
            >
              <option value={10}>10</option>
              <option value={15}>15</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
            </select>
            <span>entries (Total: {total})</span>
          </div>

          <div className="flex items-center gap-2">
            <span>Page {page} of {totalPages}</span>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="p-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="p-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
