import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import AuditLogsTab from './AuditLogsTab';
import { auditLogsApi } from '../data/store';

vi.mock('../data/store', () => ({
  auditLogsApi: {
    search: vi.fn(),
  },
}));

describe('AuditLogsTab Component', () => {
  const mockLogs = [
    {
      _id: '1',
      createdAt: '2026-08-14T10:00:00.000Z',
      actor: { name: 'Admin User', role: 'HR Director' },
      action: 'Employees imported',
      subject: 'Bulk Import',
      details: 'Imported 10 employees',
      ip: '192.168.1.1',
    },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders the header and controls properly', async () => {
    auditLogsApi.search.mockResolvedValueOnce({
      rows: mockLogs,
      total: 1,
      page: 1,
      limit: 15,
    });

    render(<AuditLogsTab />);

    expect(screen.getByText(/Audit Trail & System Activity/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search action, user, or details.../i)).toBeInTheDocument();
    expect(screen.getByText(/Export CSV/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Admin User')).toBeInTheDocument();
      expect(screen.getByText('Employees imported')).toBeInTheDocument();
    });
  });

  it('handles search input and filter form submission', async () => {
    auditLogsApi.search.mockResolvedValue({
      rows: mockLogs,
      total: 1,
      page: 1,
      limit: 15,
    });

    render(<AuditLogsTab />);

    const searchInput = screen.getByPlaceholderText(/Search action, user, or details.../i);
    fireEvent.change(searchInput, { target: { value: 'imported' } });

    const filterBtn = screen.getByRole('button', { name: /Filter/i });
    fireEvent.click(filterBtn);

    await waitFor(() => {
      expect(auditLogsApi.search).toHaveBeenCalledWith(
        expect.objectContaining({
          search: 'imported',
        })
      );
    });
  });
});
