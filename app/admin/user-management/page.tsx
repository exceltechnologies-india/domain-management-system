'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Search, Filter, MoreVertical, Trash2, Eye, EyeOff, RefreshCw, Key, UserCheck, XCircle, CheckCircle, Server, Shield, Unlock, ShieldOff, Users, UserX, Cog, ExternalLink, Download } from 'lucide-react';
import RefreshButton from '@/components/dashboard/RefreshButton';
import AdminLayout from '@/components/admin/AdminLayout';
import { AdminLayoutSkeleton, AdminUsersPageSkeleton } from '@/components/skeletons/PageSkeletons';
import AdminDataTable from '@/components/admin/AdminDataTable';
import ActionMenu from '@/components/admin/ActionMenu';
import Modal from '@/components/Modal';
import { formatIndianDate, formatIndianLongDateTime, formatIndianDateTime } from '@/lib/dateUtils';
import { showSuccessToast, showErrorToast } from '@/lib/toast';
import { performLogout } from '@/lib/logout';
import { logger } from '@/lib/logger';
import { apiClient } from '@/lib/api-client';

import type { User } from './types';

export default function AdminUsers() {
  const [user, setUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [deactivatedUsers, setDeactivatedUsers] = useState<User[]>([]);
  const [serviceUsers, setServiceUsers] = useState<User[]>([]);
  const [noServiceUsers, setNoServiceUsers] = useState<User[]>([]);
  const [activeTab, setActiveTab] = useState<'active' | 'deactivated' | 'services' | 'noservices'>('active');
  const [isExporting, setIsExporting] = useState(false);

  // Split loading states
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isDataLoading, setIsDataLoading] = useState(true);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [isPasswordResetModalOpen, setIsPasswordResetModalOpen] = useState(false);
  const [passwordResetUser, setPasswordResetUser] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isResettingPassword, setIsResettingPassword] = useState(false);
  const [sendEmailNotification, setSendEmailNotification] = useState(true);
  // Step-up re-auth: password-based admins must confirm their OWN current
  // password to reset a user's password. Social-login admins have none and are
  // exempted server-side (they leave this blank).
  const [reauthPassword, setReauthPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isDeactivateModalOpen, setIsDeactivateModalOpen] = useState(false);
  const [isReactivateModalOpen, setIsReactivateModalOpen] = useState(false);
  const [userToDeactivate, setUserToDeactivate] = useState<User | null>(null);
  const [userToReactivate, setUserToReactivate] = useState<User | null>(null);
  const [isDeactivating, setIsDeactivating] = useState(false);
  const [isReactivating, setIsReactivating] = useState(false);
  const [isPermanentDeleteModalOpen, setIsPermanentDeleteModalOpen] = useState(false);
  const [userToPermanentlyDelete, setUserToPermanentlyDelete] = useState<User | null>(null);
  const [isPermanentlyDeleting, setIsPermanentlyDeleting] = useState(false);
  const [is2FAResetModalOpen, setIs2FAResetModalOpen] = useState(false);
  const [userToReset2FA, setUserToReset2FA] = useState<User | null>(null);
  const [isResetting2FA, setIsResetting2FA] = useState(false);
  const router = useRouter();
  const { data: session, status } = useSession();

  // Action Menu State
  const [menuData, setMenuData] = useState<{
    id: string;
    x: number;
    y: number;
    user: User;
  } | null>(null);

  const handleTripleDotClick = (e: React.MouseEvent, u: User) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuData({
      id: u._id,
      x: e.clientX,
      y: e.clientY,
      user: u
    });
  };

  const handleContextMenu = (e: React.MouseEvent, u: User) => {
    e.preventDefault();
    setMenuData({
      id: u._id,
      x: e.clientX,
      y: e.clientY,
      user: u
    });
  };

  const closeMenu = () => setMenuData(null);

  useEffect(() => {
    // Wait for NextAuth to resolve
    if (status === 'loading') {
      return;
    }

    // Prefer NextAuth session (works for credentials login)
    if (session?.user) {
      const sessionUser = session.user;
      const userObj = {
        _id: sessionUser.id || '',
        firstName: sessionUser.name?.split(' ')[0] || '',
        lastName: sessionUser.name?.split(' ').slice(1).join(' ') || '',
        email: sessionUser.email || '',
        role: sessionUser.role || 'user',
        createdAt: new Date().toISOString(),
        isActive: true,
      };

      // Check if admin
      if (userObj.role !== 'admin') {
        router.push('/dashboard');
        return;
      }

      setUser(userObj as User);
      setIsAuthLoading(false);
      void loadUsers();
      return;
    }

    // No NextAuth session → redirect to login. The previous code had a
    // localStorage/token-cookie fallback, but no auth route ever wrote
    // those values — it was dead code that lit up safeLocalStorage reads
    // on every page load.
    router.push('/login');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, status, session?.user?.email]);

  const loadUsers = async () => {
    setIsDataLoading(true);
    // NextAuth cookie is shipped via credentials:'include' (automatic in apiClient);
    // no Bearer token to forward (the localStorage `token` was never written).
    const [activeResult, deactivatedResult, servicesResult, noServicesResult] = await Promise.all([
      apiClient.get<{ users?: User[] }>('/api/v1/admin/users'),
      apiClient.get<{ users?: User[] }>('/api/v1/admin/users/deactivated'),
      apiClient.get<{ users?: User[] }>('/api/v1/admin/users/services'),
      apiClient.get<{ users?: User[] }>('/api/v1/admin/users/no-services'),
    ]);

    setUsers(activeResult.ok ? (activeResult.data.users ?? []) : []);
    setDeactivatedUsers(deactivatedResult.ok ? (deactivatedResult.data.users ?? []) : []);
    if (servicesResult.ok) {
      setServiceUsers(servicesResult.data.users ?? []);
    } else {
      logger.warn('Failed to fetch service users:', servicesResult.error.message);
      setServiceUsers([]);
    }
    if (noServicesResult.ok) {
      setNoServiceUsers(noServicesResult.data.users ?? []);
    } else {
      logger.warn('Failed to fetch no-service users:', noServicesResult.error.message);
      setNoServiceUsers([]);
    }
    setIsDataLoading(false);
  };

  const handleLogout = () => {
    void performLogout();
  };

  const handleViewUser = (userId: string) => {
    // Check both active, deactivated, and service users
    const userToView = users.find(u => u._id === userId) ||
      deactivatedUsers.find(u => u._id === userId) ||
      serviceUsers.find(u => u._id === userId) ||
      noServiceUsers.find(u => u._id === userId);
    if (userToView) {
      setSelectedUser(userToView);
      setIsModalOpen(true);
    }
  };

  // Export the currently-selected tab's users to a CSV download. Users are
  // already fully loaded in state (no server pagination on this page), so the
  // export builds straight from the tab's array. Service Users carry DA/service
  // detail; the other tabs carry contact detail — columns adapt per tab.
  const handleExportCsv = () => {
    setIsExporting(true);
    try {
      const tabMeta: Record<typeof activeTab, { rows: User[]; label: string }> = {
        active: { rows: users, label: 'active' },
        deactivated: { rows: deactivatedUsers, label: 'deactivated' },
        services: { rows: serviceUsers, label: 'service-users' },
        noservices: { rows: noServiceUsers, label: 'no-services' },
      };
      const { rows, label } = tabMeta[activeTab];

      if (rows.length === 0) {
        showErrorToast('No users to export');
        return;
      }

      const esc = (v: string | number) => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };

      let header: string[];
      let toRow: (u: User) => (string | number)[];

      if (activeTab === 'services') {
        const svc = rows as Array<User & { directAdminUsername?: string; domains?: unknown[]; hosting?: unknown[] }>;
        header = ['Name', 'Email', 'DA Username', 'Domains', 'Hosting', 'Status', 'Joined'];
        toRow = (u) => {
          const s = u as (typeof svc)[number];
          return [
            `${u.firstName} ${u.lastName}`.trim(),
            u.email,
            s.directAdminUsername || '',
            s.domains?.length ?? 0,
            s.hosting?.length ?? 0,
            u.isActive === false ? 'inactive' : 'active',
            u.createdAt ? formatIndianDate(new Date(u.createdAt)) : '',
          ];
        };
      } else {
        header = ['Name', 'Email', 'Role', 'Status', 'Phone', 'WhatsApp', 'Joined'];
        toRow = (u) => {
          const c = u as User & { phone?: string; whatsappNumber?: string };
          return [
            `${u.firstName} ${u.lastName}`.trim(),
            u.email,
            u.role || 'user',
            u.isActive === false ? 'inactive' : 'active',
            c.phone || '',
            c.whatsappNumber || '',
            u.createdAt ? formatIndianDate(new Date(u.createdAt)) : '',
          ];
        };
      }

      const csv = [header, ...rows.map(toRow)].map((r) => r.map(esc).join(',')).join('\n');
      const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `users-${label}-${formatIndianDate(new Date()).replace(/\//g, '-')}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showSuccessToast(`Exported ${rows.length} user${rows.length !== 1 ? 's' : ''}`);
    } catch {
      showErrorToast('Failed to export users');
    } finally {
      setIsExporting(false);
    }
  };

  const handleResetPassword = (userId: string) => {
    const userToReset = users.find(u => u._id === userId);
    if (userToReset) {
      setPasswordResetUser(userToReset);
      setNewPassword('');
      setConfirmPassword('');
      setSendEmailNotification(true);
      setIsPasswordResetModalOpen(true);
    }
  };

  const handlePasswordResetSubmit = async () => {
    if (!passwordResetUser) return;

    if (!newPassword || !confirmPassword) {
      showErrorToast('Please fill in all fields');
      return;
    }

    if (newPassword !== confirmPassword) {
      showErrorToast('Passwords do not match');
      return;
    }

    if (newPassword.length < 6) {
      showErrorToast('Password must be at least 6 characters long');
      return;
    }

    setIsResettingPassword(true);

    const result = await apiClient.post<{ emailSent?: boolean }>(
      '/api/v1/admin/users/reset-password',
      {
        userId: passwordResetUser._id,
        newPassword,
        sendEmail: sendEmailNotification,
      },
      undefined,
      // Step-up re-auth: send the admin's current password when supplied.
      // Social-login admins leave it blank and are exempted server-side.
      reauthPassword ? { headers: { 'x-reauth-token': reauthPassword } } : {},
    );

    if (result.ok) {
      showSuccessToast(
        `Password reset successfully. ${result.data.emailSent ? 'Email sent to user.' : 'Email notification was not sent.'}`
      );
      setIsPasswordResetModalOpen(false);
      setPasswordResetUser(null);
      setNewPassword('');
      setConfirmPassword('');
      setReauthPassword('');
    } else {
      showErrorToast(result.error.status === 0 ? 'Failed to reset password' : `Failed to reset password: ${result.error.message || 'Unknown error'}`);
    }
    setIsResettingPassword(false);
  };

  const handlePasswordResetCancel = () => {
    setIsPasswordResetModalOpen(false);
    setPasswordResetUser(null);
    setNewPassword('');
    setConfirmPassword('');
    setReauthPassword('');
    setSendEmailNotification(true);
    setShowNewPassword(false);
    setShowConfirmPassword(false);
  };


  const handleDeleteUser = (user: User) => {
    setUserToDeactivate(user);
    setIsDeactivateModalOpen(true);
  };

  const confirmDeactivateUser = async () => {
    if (!userToDeactivate) return;

    setIsDeactivating(true);
    const result = await apiClient.delete<{ message?: string }>('/api/v1/admin/users', { userId: userToDeactivate._id });

    if (result.ok) {
      // Update the user object with isActive: false
      const updatedUser: User = {
        ...userToDeactivate,
        isActive: false, // Explicitly set to false
      };

      // Remove the user from active users and services, add to deactivated users with updated status
      setUsers(users.filter(user => user._id !== userToDeactivate._id));
      setServiceUsers(serviceUsers.filter(user => user._id !== userToDeactivate._id));
      setDeactivatedUsers([updatedUser, ...deactivatedUsers]);

      // Switch to deactivated users tab to show the deactivated user
      setActiveTab('deactivated');

      // Close the modal
      setIsDeactivateModalOpen(false);
      setUserToDeactivate(null);

      // Show success message
      showSuccessToast(result.data.message || 'User deactivated successfully');
    } else {
      showErrorToast(result.error.status === 0 ? 'An error occurred while deactivating the user' : result.error.message || 'Failed to deactivate user');
    }
    setIsDeactivating(false);
  };

  const cancelDeactivateUser = () => {
    setIsDeactivateModalOpen(false);
    setUserToDeactivate(null);
  };

  const handleReactivateUser = (user: User) => {
    setUserToReactivate(user);
    setIsReactivateModalOpen(true);
  };

  const confirmReactivateUser = async () => {
    if (!userToReactivate) return;

    setIsReactivating(true);
    const result = await apiClient.post<{ user?: { firstName?: string; lastName?: string; email?: string } }>(
      '/api/v1/admin/users/reactivate',
      { userId: userToReactivate._id }
    );

    if (result.ok) {
      // Update the user object with the response data (which includes isActive: true)
      const updatedUser: User = {
        ...userToReactivate,
        isActive: true, // Explicitly set to true
        firstName: result.data.user?.firstName || userToReactivate.firstName,
        lastName: result.data.user?.lastName || userToReactivate.lastName,
        email: result.data.user?.email || userToReactivate.email,
      };

      // Remove the user from deactivated users and services (to be safe), add to active users with updated status
      setDeactivatedUsers(deactivatedUsers.filter(user => user._id !== userToReactivate._id));
      setServiceUsers(serviceUsers.filter(user => user._id !== userToReactivate._id));
      setUsers([updatedUser, ...users]);

      // Show success toast
      showSuccessToast('User reactivated successfully');

      // Close the modal
      setIsReactivateModalOpen(false);
      setUserToReactivate(null);
    } else {
      showErrorToast(result.error.message || 'Failed to reactivate user');
    }
    setIsReactivating(false);
  };

  const cancelReactivateUser = () => {
    setIsReactivateModalOpen(false);
    setUserToReactivate(null);
  };

  const handlePermanentDeleteUser = (user: User) => {
    setUserToPermanentlyDelete(user);
    setIsPermanentDeleteModalOpen(true);
  };

  const confirmPermanentDeleteUser = async () => {
    if (!userToPermanentlyDelete) return;

    setIsPermanentlyDeleting(true);
    const result = await apiClient.delete<{ message?: string }>(`/api/v1/admin/users?permanent=true`, { userId: userToPermanentlyDelete._id });

    if (result.ok) {
      // Remove the user from all lists
      setDeactivatedUsers(deactivatedUsers.filter(user => user._id !== userToPermanentlyDelete._id));
      setUsers(users.filter(user => user._id !== userToPermanentlyDelete._id));
      setServiceUsers(serviceUsers.filter(user => user._id !== userToPermanentlyDelete._id));

      // Close the modal
      setIsPermanentDeleteModalOpen(false);
      setUserToPermanentlyDelete(null);

      // Show success message
      showSuccessToast(result.data.message || 'User permanently deleted successfully');
    } else {
      showErrorToast(result.error.status === 0 ? 'An error occurred while deleting the user' : result.error.message || 'Failed to delete user');
    }
    setIsPermanentlyDeleting(false);
  };

  const cancelPermanentDeleteUser = () => {
    setIsPermanentDeleteModalOpen(false);
    setUserToPermanentlyDelete(null);
  };

  const handle2FAResetClick = (u: User) => {
    setUserToReset2FA(u);
    setIs2FAResetModalOpen(true);
  };

  const confirm2FAReset = async () => {
    if (!userToReset2FA) return;
    setIsResetting2FA(true);
    const result = await apiClient.post<{ message?: string }>('/api/v1/admin/users/reset-2fa', { userId: userToReset2FA._id });

    if (result.ok) {
      // Update local state so badge disappears immediately
      const patch = (list: User[]) =>
        list.map(u => u._id === userToReset2FA._id ? { ...u, totpEnabled: false } : u);
      setUsers(patch);
      setServiceUsers(patch);
      showSuccessToast(result.data.message || '2FA reset successfully');
      setIs2FAResetModalOpen(false);
      setUserToReset2FA(null);
    } else {
      showErrorToast(result.error.status === 0 ? 'An error occurred while resetting 2FA' : result.error.message || 'Failed to reset 2FA');
    }
    setIsResetting2FA(false);
  };

  const cancel2FAReset = () => {
    setIs2FAResetModalOpen(false);
    setUserToReset2FA(null);
  };

  const activeColumns = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      render: (_value: unknown, row: User) => (
        <div>
          <div className="text-xs sm:text-sm font-medium text-ink">
            {row.firstName} {row.lastName}
          </div>
          <div className="text-xs sm:text-sm text-ink-3 truncate max-w-[150px] sm:max-w-none">{row.email}</div>
        </div>
      )
    },
    {
      key: 'role',
      label: 'Role',
      sortable: true,
      render: (value: string) => (
        <span className="px-1.5 sm:px-2 py-0.5 sm:py-1 text-[10px] sm:text-xs font-medium rounded-full bg-indigo-soft text-indigo-ink">
          user
        </span>
      )
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (_value: unknown, row: User) => (
        <div className="flex flex-col gap-1">
          <span className={`px-1.5 sm:px-2 py-0.5 sm:py-1 text-[10px] sm:text-xs font-medium rounded-full w-fit ${row.isActive ? 'bg-emerald-soft text-emerald-ink' : 'bg-paper-2 text-ink'}`}>
            {row.isActive ? 'active' : 'inactive'}
          </span>
          {row.totpEnabled && (
            <span className="px-1.5 sm:px-2 py-0.5 sm:py-1 text-[10px] sm:text-xs font-medium rounded-full w-fit bg-purple-100 text-purple-800 flex items-center gap-1">
              <Shield className="h-2.5 w-2.5" />
              2FA on
            </span>
          )}
        </div>
      )
    },
    {
      key: 'createdAt',
      label: 'Joined',
      sortable: true,
      render: (value: string) => {
        if (!value) {
          return <span className="text-xs sm:text-sm text-ink-4">-</span>;
        }

        const date = new Date(value);
        if (isNaN(date.getTime())) {
          return <span className="text-xs sm:text-sm text-ink-4">-</span>;
        }

        return (
          <span className="text-xs sm:text-sm text-ink-2">
            {formatIndianDate(date)}
          </span>
        );
      }
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (_value: unknown, row: User) => (
        <button
          onClick={(e) => handleTripleDotClick(e, row)}
          aria-label={`Actions for ${row.firstName ? `${row.firstName} ${row.lastName || ''}`.trim() : row.email}`}
          className={`p-2 rounded-lg transition-all duration-200 ${menuData?.id === row._id ? 'bg-amber-soft text-amber-ink' : 'text-ink-4 hover:text-ink-2 hover:bg-paper-2'}`}
        >
          <MoreVertical className="h-5 w-5" />
        </button>
      )
    }
  ];

  const deactivatedColumns = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      render: (_value: unknown, row: User) => (
        <div>
          <div className="text-xs sm:text-sm font-medium text-ink">
            {row.firstName} {row.lastName}
          </div>
          <div className="text-xs sm:text-sm text-ink-3 truncate max-w-[150px] sm:max-w-none">{row.email}</div>
        </div>
      )
    },
    {
      key: 'role',
      label: 'Role',
      sortable: true,
      render: (value: string) => (
        <span className="px-1.5 sm:px-2 py-0.5 sm:py-1 text-[10px] sm:text-xs font-medium rounded-full bg-indigo-soft text-indigo-ink">
          user
        </span>
      )
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (_value: unknown, row: User) => (
        <span className="px-1.5 sm:px-2 py-0.5 sm:py-1 text-[10px] sm:text-xs font-medium rounded-full bg-rose-soft text-rose-ink">
          deactivated
        </span>
      )
    },
    {
      key: 'createdAt',
      label: 'Joined',
      sortable: true,
      render: (value: string) => {
        if (!value) {
          return <span className="text-xs sm:text-sm text-ink-4">-</span>;
        }

        const date = new Date(value);
        if (isNaN(date.getTime())) {
          return <span className="text-xs sm:text-sm text-ink-4">-</span>;
        }

        return (
          <span className="text-xs sm:text-sm text-ink">
            {formatIndianDate(date)}
          </span>
        );
      }
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (_value: unknown, row: User) => (
        <button
          onClick={(e) => handleTripleDotClick(e, row)}
          aria-label={`Actions for ${row.firstName ? `${row.firstName} ${row.lastName || ''}`.trim() : row.email}`}
          className={`p-2 rounded-lg transition-all duration-200 ${menuData?.id === row._id ? 'bg-amber-soft text-amber-ink' : 'text-ink-4 hover:text-ink-2 hover:bg-paper-2'}`}
        >
          <MoreVertical className="h-5 w-5" />
        </button>
      )
    }
  ];

  /* State for Service Details Modal */
  interface ServiceUser extends User {
    directAdminUsername?: string;
    domains?: Array<{ domainName: string; status?: string; expiresAt?: string; expiryDate?: string }>;
    hosting?: Array<{ domainName?: string; name?: string; status?: string; expiryDate?: string }>;
  }
  const [isServiceModalOpen, setIsServiceModalOpen] = useState(false);
  const [selectedServiceUser, setSelectedServiceUser] = useState<ServiceUser | null>(null);

  const handleViewServiceDetails = (user: ServiceUser) => {
    setSelectedServiceUser(user);
    setIsServiceModalOpen(true);
  };

  const serviceColumns = [
    {
      key: 'name',
      label: 'Client Name',
      sortable: true,
      render: (_value: unknown, row: ServiceUser) => (
        <div>
          <div className="text-xs sm:text-sm font-medium text-ink">
            {row.firstName} {row.lastName}
          </div>
          <div className="text-xs sm:text-sm text-ink-3 truncate max-w-[150px] sm:max-w-none">{row.email}</div>
        </div>
      )
    },
    {
      key: 'services',
      label: 'Services',
      render: (_value: unknown, row: ServiceUser) => (
        <div className="flex flex-col gap-1">
          {row.domains && row.domains.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo"></span>
              <span className="text-xs text-ink-2">
                {row.domains.length} Domain{row.domains.length !== 1 ? 's' : ''}
              </span>
              <span className="text-[10px] text-ink-4">({row.domains[0].domainName})</span>
            </div>
          )}
          {row.hosting && row.hosting.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-purple-500"></span>
              <span className="text-xs text-ink-2">
                {row.hosting.length} Hosting
              </span>
              <span className="text-[10px] text-ink-4">({row.hosting[0].name})</span>
            </div>
          )}
        </div>
      )
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (_value: unknown, row: User) => (
        <span className={`px-1.5 sm:px-2 py-0.5 sm:py-1 text-[10px] sm:text-xs font-medium rounded-full ${row.isActive ? 'bg-emerald-soft text-emerald-ink' : 'bg-paper-2 text-ink'
          }`}>
          {row.isActive ? 'active' : 'inactive'}
        </span>
      )
    },
    {
      key: 'joined',
      label: 'Joined',
      sortable: true,
      render: (_value: unknown, row: User) => (
        <span className="text-xs sm:text-sm text-ink-2">
          {formatIndianDate(new Date(row.createdAt))}
        </span>
      )
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (_value: unknown, row: User) => (
        <button
          onClick={(e) => handleTripleDotClick(e, row)}
          aria-label={`Actions for ${row.firstName ? `${row.firstName} ${row.lastName || ''}`.trim() : row.email}`}
          className={`p-2 rounded-lg transition-all duration-200 ${menuData?.id === row._id ? 'bg-amber-soft text-amber-ink' : 'text-ink-4 hover:text-ink-2 hover:bg-paper-2'}`}
        >
          <MoreVertical className="h-5 w-5" />
        </button>
      )
    }
  ];

  // Registered-but-never-converted users (zero domains + zero hosting + no DA
  // account). Re-engagement audience — contact columns matter more than
  // service columns, so we surface phone + WhatsApp for outreach.
  const noServiceColumns = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      render: (_value: unknown, row: User) => (
        <div>
          <div className="text-xs sm:text-sm font-medium text-ink">
            {row.firstName} {row.lastName}
          </div>
          <div className="text-xs sm:text-sm text-ink-3 truncate max-w-[150px] sm:max-w-none">{row.email}</div>
        </div>
      )
    },
    {
      key: 'phone',
      label: 'Phone',
      render: (_value: unknown, row: User) => (
        <span className="text-xs sm:text-sm text-ink-2">
          {(row as User & { phone?: string }).phone || <span className="text-ink-4">-</span>}
        </span>
      )
    },
    {
      key: 'whatsappNumber',
      label: 'WhatsApp',
      render: (_value: unknown, row: User) => {
        const wa = (row as User & { whatsappNumber?: string }).whatsappNumber;
        return wa
          ? <span className="text-xs sm:text-sm text-green-700">{wa}</span>
          : <span className="text-xs sm:text-sm text-ink-4">-</span>;
      }
    },
    {
      key: 'createdAt',
      label: 'Joined',
      sortable: true,
      render: (_value: unknown, row: User) => (
        <span className="text-xs sm:text-sm text-ink-2">
          {row.createdAt ? formatIndianDate(new Date(row.createdAt)) : '-'}
        </span>
      )
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (_value: unknown, row: User) => (
        <button
          onClick={(e) => handleTripleDotClick(e, row)}
          aria-label={`Actions for ${row.firstName ? `${row.firstName} ${row.lastName || ''}`.trim() : row.email}`}
          className={`p-2 rounded-lg transition-all duration-200 ${menuData?.id === row._id ? 'bg-amber-soft text-amber-ink' : 'text-ink-4 hover:text-ink-2 hover:bg-paper-2'}`}
        >
          <MoreVertical className="h-5 w-5" />
        </button>
      )
    }
  ];

  // Animated Loading Component
  const AnimatedLoading = () => {
    const [dots, setDots] = useState('');

    useEffect(() => {
      const interval = setInterval(() => {
        setDots(prev => {
          if (prev === '') return '.';
          if (prev === '.') return '..';
          if (prev === '..') return '...';
          return '';
        });
      }, 500);

      return () => clearInterval(interval);
    }, []);

    return <span className="inline-block w-6 text-left">{dots}</span>;
  };

  if (!user || isAuthLoading) {
    return <AdminLayoutSkeleton><AdminUsersPageSkeleton /></AdminLayoutSkeleton>;
  }

  return (
    <AdminLayout user={user} onLogout={handleLogout}>
      <div className="space-y-6">

        {/* ── Page header ── */}
        <div className="flex items-start sm:items-center justify-between flex-col sm:flex-row gap-3 sm:gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-soft rounded-xl">
              <Users className="h-5 w-5 text-amber-ink" />
            </div>
            <div>
              <h1 className="text-2xl font-bold font-serif text-ink">User Management</h1>
              <p className="text-sm text-ink-3 mt-0.5">Manage user accounts and permissions</p>
            </div>
          </div>
          <RefreshButton onClick={loadUsers} isLoading={isDataLoading} />
        </div>

        {/* ── Summary stat cards ── */}
        {!isDataLoading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <button
              onClick={() => setActiveTab('active')}
              className={`bg-paper border rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3 text-left transition-all ${activeTab === 'active' ? 'border-amber ring-2 ring-amber/25' : 'border-hairline hover:border-hairline-strong hover:shadow-md'}`}
            >
              <div className="p-2 bg-emerald-soft rounded-xl">
                <UserCheck className="h-4 w-4 text-green-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-ink-3">Active Users</p>
                <p className="text-xl font-bold text-ink">{users.length}</p>
              </div>
            </button>
            <button
              onClick={() => setActiveTab('deactivated')}
              className={`bg-paper border rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3 text-left transition-all ${activeTab === 'deactivated' ? 'border-amber ring-2 ring-amber/25' : 'border-hairline hover:border-hairline-strong hover:shadow-md'}`}
            >
              <div className="p-2 bg-rose-soft rounded-xl">
                <UserX className="h-4 w-4 text-red-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-ink-3">Deactivated</p>
                <p className="text-xl font-bold text-ink">{deactivatedUsers.length}</p>
              </div>
            </button>
            <button
              onClick={() => setActiveTab('services')}
              className={`bg-paper border rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3 text-left transition-all ${activeTab === 'services' ? 'border-amber ring-2 ring-amber/25' : 'border-hairline hover:border-hairline-strong hover:shadow-md'}`}
            >
              <div className="p-2 bg-purple-50 rounded-xl">
                <Cog className="h-4 w-4 text-purple-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-ink-3">Service Users</p>
                <p className="text-xl font-bold text-ink">{serviceUsers.length}</p>
              </div>
            </button>
            <button
              onClick={() => setActiveTab('noservices')}
              className={`bg-paper border rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3 text-left transition-all ${activeTab === 'noservices' ? 'border-amber ring-2 ring-amber/25' : 'border-hairline hover:border-hairline-strong hover:shadow-md'}`}
            >
              <div className="p-2 bg-amber-50 rounded-xl">
                <UserX className="h-4 w-4 text-amber-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-ink-3">No Services</p>
                <p className="text-xl font-bold text-ink">{noServiceUsers.length}</p>
              </div>
            </button>
          </div>
        )}

        {/* ── Users card ── */}
        <div className="bg-paper border border-hairline rounded-2xl shadow-sm overflow-hidden">
          {/* Card header — segmented tabs */}
          <div className="px-6 py-4 border-b border-hairline bg-paper-2/60 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2.5">
              <Users className="h-4 w-4 text-ink-3" />
              <h3 className="text-sm font-semibold text-ink">
                {activeTab === 'active' && 'Active Users'}
                {activeTab === 'deactivated' && 'Deactivated Users'}
                {activeTab === 'services' && 'Service Users'}
                {activeTab === 'noservices' && 'Registered — No Services'}
              </h3>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="inline-flex bg-paper-2 rounded-xl p-1">
                {[
                  { id: 'active',      label: 'Active',      count: users.length },
                  { id: 'deactivated', label: 'Deactivated', count: deactivatedUsers.length },
                  { id: 'services',    label: 'Services',    count: serviceUsers.length },
                  { id: 'noservices',  label: 'No Services', count: noServiceUsers.length },
                ].map(t => (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id as 'active' | 'deactivated' | 'services' | 'noservices')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                      activeTab === t.id
                        ? 'bg-paper text-ink shadow-sm'
                        : 'text-ink-3 hover:text-ink-2'
                    }`}
                  >
                    {t.label} <span className={`ml-1 ${activeTab === t.id ? 'text-amber-ink' : 'text-ink-4'}`}>({t.count})</span>
                  </button>
                ))}
              </div>
              {(() => {
                const tabCount = { active: users.length, deactivated: deactivatedUsers.length, services: serviceUsers.length, noservices: noServiceUsers.length }[activeTab];
                const isEmpty = tabCount === 0;
                return (
                  <button
                    onClick={handleExportCsv}
                    disabled={isExporting || isEmpty}
                    title={isEmpty ? 'Nothing to export in this tab' : "Export the current tab's users as a CSV file"}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber text-white hover:brightness-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100"
                  >
                    {isExporting ? (
                      <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {isExporting ? 'Exporting…' : 'Export CSV'}
                  </button>
                );
              })()}
            </div>
          </div>

          {/* Tab content */}
          <div className="p-4 sm:p-6">
            {isDataLoading ? (
              <AdminUsersPageSkeleton />
            ) : (
              <>
                {activeTab === 'active' && (
                  <AdminDataTable
                    title=""
                    columns={activeColumns}
                    data={users}
                    searchable={true}
                    pagination={true}
                    pageSize={10}
                    onRowContextMenu={handleContextMenu}
                  />
                )}

                {activeTab === 'deactivated' && (
                  <AdminDataTable
                    title=""
                    columns={deactivatedColumns}
                    data={deactivatedUsers}
                    searchable={true}
                    pagination={true}
                    pageSize={10}
                    onRowContextMenu={handleContextMenu}
                  />
                )}

                {activeTab === 'services' && (
                  <AdminDataTable
                    title=""
                    columns={serviceColumns}
                    data={serviceUsers}
                    searchable={true}
                    pagination={true}
                    pageSize={10}
                    onRowContextMenu={handleContextMenu}
                  />
                )}

                {activeTab === 'noservices' && (
                  <AdminDataTable
                    title=""
                    columns={noServiceColumns}
                    data={noServiceUsers}
                    searchable={true}
                    pagination={true}
                    pageSize={10}
                    onRowContextMenu={handleContextMenu}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* User Details Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="User Details"
      >
        {selectedUser ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className="text-sm font-medium text-ink-3">Full Name</label>
                <p className="text-lg font-semibold text-ink">
                  {selectedUser.firstName} {selectedUser.lastName}
                </p>
              </div>

              <div>
                <label className="text-sm font-medium text-ink-3">Email Address</label>
                <p className="text-lg font-semibold text-ink">{selectedUser.email}</p>
              </div>

              <div>
                <label className="text-sm font-medium text-ink-3">Role</label>
                <span className="inline-flex px-2 py-1 text-xs font-medium rounded-full bg-indigo-soft text-indigo-ink">
                  {selectedUser.role}
                </span>
              </div>

              <div>
                <label className="text-sm font-medium text-ink-3">Account Status</label>
                <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${selectedUser.isActive
                  ? 'bg-emerald-soft text-emerald-ink'
                  : 'bg-rose-soft text-rose-ink'
                  }`}>
                  {selectedUser.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>

              <div>
                <label className="text-sm font-medium text-ink-3">Registration Date</label>
                <p className="text-lg font-semibold text-ink">
                  {formatIndianLongDateTime(selectedUser.createdAt)}
                </p>
              </div>


            </div>

            <div className="mt-6 flex justify-end space-x-3">
              <button
                onClick={() => setIsModalOpen(false)}
                className="px-4 py-2 text-sm font-medium text-ink-2 bg-paper border border-hairline-strong rounded-md hover:bg-paper-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <div className="text-center py-4">
            <p className="text-ink-3">No user selected</p>
          </div>
        )}
      </Modal>

      {/* Password Reset Modal */}
      <Modal
        isOpen={isPasswordResetModalOpen}
        onClose={handlePasswordResetCancel}
        title="Reset User Password"
      >
        {passwordResetUser ? (
          <div className="space-y-4">
            <div className="bg-amber-soft border border-hairline rounded-lg p-4">
              <div className="flex">
                <div className="flex-shrink-0">
                  <div className="w-5 h-5 bg-amber rounded-full flex items-center justify-center">
                    <span className="text-paper text-xs font-bold">!</span>
                  </div>
                </div>
                <div className="ml-3">
                  <h3 className="text-sm font-medium text-amber-ink">
                    Reset Password for {passwordResetUser.firstName} {passwordResetUser.lastName}
                  </h3>
                  <p className="text-sm text-yellow-700 mt-1">
                    This will change the user's password and optionally send them an email notification.
                  </p>
                </div>
              </div>
            </div>

            <form onSubmit={(e) => { e.preventDefault(); void handlePasswordResetSubmit(); }}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-ink-2 mb-1">
                    New Password
                  </label>
                  <div className="relative">
                    <input
                      type={showNewPassword ? "text" : "password"}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Enter new password (min 6 characters)"
                      className="w-full px-3 py-2 pr-10 border border-hairline-strong rounded-md focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword(!showNewPassword)}
                      className="absolute inset-y-0 right-0 flex items-center pr-3 text-ink-4 hover:text-ink-2 focus:outline-none"
                      title={showNewPassword ? "Hide password" : "Show password"}
                    >
                      {showNewPassword ? (
                        <EyeOff className="h-5 w-5" />
                      ) : (
                        <Eye className="h-5 w-5" />
                      )}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-ink-2 mb-1">
                    Confirm Password
                  </label>
                  <div className="relative">
                    <input
                      type={showConfirmPassword ? "text" : "password"}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Confirm new password"
                      className="w-full px-3 py-2 pr-10 border border-hairline-strong rounded-md focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="absolute inset-y-0 right-0 flex items-center pr-3 text-ink-4 hover:text-ink-2 focus:outline-none"
                      title={showConfirmPassword ? "Hide password" : "Show password"}
                    >
                      {showConfirmPassword ? (
                        <EyeOff className="h-5 w-5" />
                      ) : (
                        <Eye className="h-5 w-5" />
                      )}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-ink-2 mb-1">
                    Your current password
                  </label>
                  <input
                    type="password"
                    value={reauthPassword}
                    onChange={(e) => setReauthPassword(e.target.value)}
                    placeholder="Confirm it's really you"
                    className="w-full px-3 py-2 border border-hairline-strong rounded-md focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
                    autoComplete="current-password"
                  />
                  <p className="mt-1 text-xs text-ink-3">
                    Required only if your admin account uses a password. If you sign in with Google, leave this blank.
                  </p>
                </div>

                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="sendEmail"
                    checked={sendEmailNotification}
                    onChange={(e) => setSendEmailNotification(e.target.checked)}
                    className="h-4 w-4 text-amber focus:ring-amber border-hairline-strong rounded"
                  />
                  <label htmlFor="sendEmail" className="ml-2 block text-sm text-ink-2">
                    Send email notification to user with new password
                  </label>
                </div>

                <div className="mt-6 flex justify-end space-x-3">
                  <button
                    type="button"
                    onClick={handlePasswordResetCancel}
                    className="px-4 py-2 text-sm font-medium text-ink-2 bg-paper border border-hairline-strong rounded-md hover:bg-paper-2 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isResettingPassword}
                    className="px-4 py-2 text-sm font-medium text-white bg-amber border border-transparent rounded-md hover:brightness-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                  >
                    {isResettingPassword ? (
                      'Resetting...'
                    ) : (
                      'Reset Password'
                    )}
                  </button>
                </div>
              </div>
            </form>
          </div>
        ) : (
          <div className="text-center py-4">
            <p className="text-ink-3">No user selected</p>
          </div>
        )
        }
      </Modal >

      {/* Deactivate User Confirmation Modal */}
      {
        isDeactivateModalOpen && userToDeactivate && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-paper rounded-xl shadow-xl max-w-md w-full">
              <div className="p-6">
                <div className="flex items-center mb-4">
                  <div className="flex-shrink-0">
                    <XCircle className="h-6 w-6 text-red-600" />
                  </div>
                  <div className="ml-3">
                    <h3 className="text-lg font-medium text-ink">
                      Deactivate User
                    </h3>
                  </div>
                </div>

                <div className="mb-6">
                  <p className="text-ink-2 mb-2">
                    Are you sure you want to deactivate this user? They will not be able to log in but their data will be preserved.
                  </p>
                  <div className="bg-paper-2/60 rounded-lg p-3">
                    <div className="text-sm">
                      <div className="font-medium text-ink">
                        {userToDeactivate.firstName} {userToDeactivate.lastName}
                      </div>
                      <div className="text-ink-2">
                        {userToDeactivate.email}
                      </div>
                      <div className="text-ink-2">
                        Role: {userToDeactivate.role}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end space-x-3">
                  <button
                    onClick={cancelDeactivateUser}
                    disabled={isDeactivating}
                    className="px-4 py-2 text-ink-2 bg-paper-2 hover:bg-hairline rounded-lg transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmDeactivateUser}
                    disabled={isDeactivating}
                    className="px-4 py-2 bg-rose hover:bg-rose-ink text-white rounded-lg transition-colors disabled:opacity-50 flex items-center"
                  >
                    {isDeactivating ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                        Deactivating...
                      </>
                    ) : (
                      <>
                        <XCircle className="h-4 w-4 mr-2" />
                        Deactivate User
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      }

      {/* Reactivate User Confirmation Modal */}
      {
        isReactivateModalOpen && userToReactivate && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-paper rounded-xl shadow-xl max-w-md w-full">
              <div className="p-6">
                <div className="flex items-center mb-4">
                  <div className="flex-shrink-0">
                    <CheckCircle className="h-6 w-6 text-green-600" />
                  </div>
                  <div className="ml-3">
                    <h3 className="text-lg font-medium text-ink">
                      Reactivate User
                    </h3>
                  </div>
                </div>

                <div className="mb-6">
                  <p className="text-ink-2 mb-2">
                    Are you sure you want to reactivate this user? They will be able to log in again.
                  </p>
                  <div className="bg-paper-2/60 rounded-lg p-3">
                    <div className="text-sm">
                      <div className="font-medium text-ink">
                        {userToReactivate.firstName} {userToReactivate.lastName}
                      </div>
                      <div className="text-ink-2">
                        {userToReactivate.email}
                      </div>
                      <div className="text-ink-2">
                        Role: {userToReactivate.role}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end space-x-3">
                  <button
                    onClick={cancelReactivateUser}
                    disabled={isReactivating}
                    className="px-4 py-2 text-ink-2 bg-paper-2 hover:bg-hairline rounded-lg transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmReactivateUser}
                    disabled={isReactivating}
                    className="px-4 py-2 bg-emerald hover:bg-emerald-ink text-white rounded-lg transition-colors disabled:opacity-50 flex items-center"
                  >
                    {isReactivating ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                        Reactivating...
                      </>
                    ) : (
                      <>
                        <CheckCircle className="h-4 w-4 mr-2" />
                        Reactivate User
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      }

      {/* Permanent Delete User Confirmation Modal */}
      {
        isPermanentDeleteModalOpen && userToPermanentlyDelete && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-paper rounded-xl shadow-xl max-w-md w-full">
              <div className="p-6">
                <div className="flex items-center mb-4">
                  <div className="flex-shrink-0">
                    <Trash2 className="h-6 w-6 text-red-600" />
                  </div>
                  <div className="ml-3">
                    <h3 className="text-lg font-medium text-ink">
                      Permanently Delete User
                    </h3>
                  </div>
                </div>

                <div className="mb-6">
                  <div className="bg-rose-soft border border-red-200 rounded-lg p-4 mb-4">
                    <p className="text-rose-ink text-sm font-medium">
                      Warning: This action is irreversible!
                    </p>
                    <p className="text-red-700 text-sm mt-1">
                      All user data, including services and history, will be permanently removed.
                    </p>
                  </div>
                  <p className="text-ink-2 mb-2">
                    Are you sure you want to permanently delete this user?
                  </p>
                  <div className="bg-paper-2/60 rounded-lg p-3">
                    <div className="text-sm">
                      <div className="font-medium text-ink">
                        {userToPermanentlyDelete.firstName} {userToPermanentlyDelete.lastName}
                      </div>
                      <div className="text-ink-2">
                        {userToPermanentlyDelete.email}
                      </div>
                      <div className="text-ink-2">
                        Role: {userToPermanentlyDelete.role}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end space-x-3">
                  <button
                    onClick={cancelPermanentDeleteUser}
                    disabled={isPermanentlyDeleting}
                    className="px-4 py-2 text-ink-2 bg-paper-2 hover:bg-hairline rounded-lg transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmPermanentDeleteUser}
                    disabled={isPermanentlyDeleting}
                    className="px-4 py-2 bg-rose hover:bg-rose-ink text-white rounded-lg transition-colors disabled:opacity-50 flex items-center"
                  >
                    {isPermanentlyDeleting ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                        Deleting...
                      </>
                    ) : (
                      <>
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete Permanently
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      }
      {/* Service Details Modal */}
      <Modal
        isOpen={isServiceModalOpen}
        onClose={() => setIsServiceModalOpen(false)}
        title="User Services"
        size="xl"
      >
        {selectedServiceUser && (
          <div className="space-y-6">
            <div className="flex items-center gap-4 border-b border-hairline pb-4">
              <div className="h-12 w-12 bg-amber-soft text-amber-ink rounded-full flex items-center justify-center font-bold text-lg">
                {selectedServiceUser.firstName?.charAt(0)}
              </div>
              <div>
                <h3 className="text-lg font-bold text-ink">
                  {selectedServiceUser.firstName} {selectedServiceUser.lastName}
                </h3>
                <p className="text-sm text-ink-3">{selectedServiceUser.email}</p>
                {selectedServiceUser.directAdminUsername && (
                  <span className="text-xs bg-paper-2 text-ink-2 px-2 py-0.5 rounded mt-1 inline-block">
                    DA User: {selectedServiceUser.directAdminUsername}
                  </span>
                )}
              </div>
            </div>

            {/* Hosting Section */}
            <div>
              <h4 className="flex items-center gap-2 text-sm font-bold text-ink uppercase tracking-wider mb-3">
                <Server className="h-4 w-4 text-purple-600" /> Hosting Services
              </h4>
              {selectedServiceUser.hosting && selectedServiceUser.hosting.length > 0 ? (
                <div className="bg-paper border border-hairline rounded-lg overflow-hidden">
                  <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-hairline">
                    <thead className="bg-paper-2/60">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-3 uppercase">Package</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-3 uppercase">Domain</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-3 uppercase">Status</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-3 uppercase">Expires</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-ink-3 uppercase">Manage</th>
                      </tr>
                    </thead>
                    <tbody className="bg-paper divide-y divide-hairline">
                      {selectedServiceUser.hosting.map((host: NonNullable<ServiceUser['hosting']>[number], i: number) => (
                        <tr key={i}>
                          <td className="px-4 py-3 text-sm font-medium text-ink">{host.name || 'Standard Hosting'}</td>
                          <td className="px-4 py-3 text-sm text-ink-3">{host.domainName}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-1 text-xs font-medium rounded-full ${host.status === 'active' ? 'bg-emerald-soft text-emerald-ink' :
                              host.status === 'suspended' ? 'bg-orange-100 text-orange-800' :
                                host.status === 'terminated' || host.status === 'expired' ? 'bg-rose-soft text-rose-ink' :
                                  'bg-paper-2 text-ink'
                              }`}>
                              {host.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-ink-3">
                            {host.expiryDate ? formatIndianDate(new Date(host.expiryDate)) : '-'}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {/* Deep-link to /admin/hosting pre-filtered to this
                                domain so the operator can jump straight to the
                                hosting management surface without leaving this
                                modal, navigating away, and searching manually.
                                /admin/hosting reads `?q=` on mount and pre-fills
                                its search input. Skipped when domainName is
                                missing (defensive — the row would be useless
                                for management anyway). */}
                            {host.domainName ? (
                              <Link
                                href={`/admin/hosting?q=${encodeURIComponent(host.domainName)}`}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-md transition-colors"
                                title={`Open ${host.domainName} in the hosting admin`}
                              >
                                Open
                                <ExternalLink className="h-3 w-3" />
                              </Link>
                            ) : (
                              <span className="text-xs text-ink-4">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-ink-3 italic bg-paper-2/60 p-4 rounded-lg text-center">No hosting services found.</div>
              )}
            </div>

            {/* Domains Section */}
            <div>
              <h4 className="flex items-center gap-2 text-sm font-bold text-ink uppercase tracking-wider mb-3">
                <div className="h-4 w-4 bg-indigo rounded-full flex items-center justify-center text-[8px] text-white">D</div> Domains
              </h4>
              {selectedServiceUser.domains && selectedServiceUser.domains.length > 0 ? (
                <div className="bg-paper border border-hairline rounded-lg overflow-hidden">
                  <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-hairline">
                    <thead className="bg-paper-2/60">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-3 uppercase">Domain Name</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-3 uppercase">Status</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-ink-3 uppercase">Expires</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-ink-3 uppercase">Manage</th>
                      </tr>
                    </thead>
                    <tbody className="bg-paper divide-y divide-hairline">
                      {selectedServiceUser.domains.map((domain: NonNullable<ServiceUser['domains']>[number], i: number) => (
                        <tr key={i}>
                          <td className="px-4 py-3 text-sm font-medium text-ink">{domain.domainName}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-1 text-xs font-medium rounded-full ${domain.status === 'registered' || domain.status === 'active' ? 'bg-emerald-soft text-emerald-ink' :
                              domain.status === 'expired' ? 'bg-rose-soft text-rose-ink' :
                                domain.status === 'pending' ? 'bg-amber-soft text-amber-ink' :
                                  'bg-paper-2 text-ink'
                              }`}>
                              {domain.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-ink-3">
                            {domain.expiryDate ? formatIndianDate(new Date(domain.expiryDate)) : '-'}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {/* Deep-link to /admin/domains pre-filtered to this
                                domain — mirrors the Hosting Services pill above.
                                /admin/domains reads `?q=` on mount and pre-fills
                                its search input. */}
                            {domain.domainName ? (
                              <Link
                                href={`/admin/domains?q=${encodeURIComponent(domain.domainName)}`}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-md transition-colors"
                                title={`Open ${domain.domainName} in the domains admin`}
                              >
                                Open
                                <ExternalLink className="h-3 w-3" />
                              </Link>
                            ) : (
                              <span className="text-xs text-ink-4">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-ink-3 italic bg-paper-2/60 p-4 rounded-lg text-center">No registered domains found.</div>
              )}
            </div>

          </div>
        )}
      </Modal>

      {/* 2FA Reset Confirmation Modal */}
      {is2FAResetModalOpen && userToReset2FA && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-paper rounded-xl shadow-xl max-w-md w-full p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-orange-100 rounded-full flex items-center justify-center flex-shrink-0">
                <ShieldOff className="h-5 w-5 text-orange-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-ink">Reset 2FA</h3>
                <p className="text-sm text-ink-3">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-sm text-ink-2 mb-2">
              You are about to disable two-factor authentication for:
            </p>
            <div className="bg-paper-2/60 rounded-lg px-4 py-3 mb-4">
              <p className="text-sm font-semibold text-ink">{userToReset2FA.firstName} {userToReset2FA.lastName}</p>
              <p className="text-xs text-ink-3">{userToReset2FA.email}</p>
            </div>
            <p className="text-sm text-ink-2 mb-6">
              Their current session will be invalidated and they will need to log in again. They can set up 2FA again from their security settings.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={cancel2FAReset}
                disabled={isResetting2FA}
                className="px-4 py-2 text-sm font-medium text-ink-2 bg-paper-2 hover:bg-hairline rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirm2FAReset}
                disabled={isResetting2FA}
                className="px-4 py-2 text-sm font-medium text-white bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {isResetting2FA ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <ShieldOff className="h-4 w-4" />
                )}
                Reset 2FA
              </button>
            </div>
          </div>
        </div>
      )}

      <ActionMenu
        isOpen={!!menuData}
        onClose={closeMenu}
        anchorPoint={{ x: menuData?.x || 0, y: menuData?.y || 0 }}
        items={menuData ? [
          {
            label: 'View Details',
            icon: Eye,
            onClick: () => handleViewUser(menuData.user._id)
          },
          ...(activeTab === 'services' ? [{
            label: 'View Services',
            icon: Server,
            onClick: () => handleViewServiceDetails(menuData.user)
          }] : []),
          {
            label: 'Reset Password',
            icon: Key,
            onClick: () => handleResetPassword(menuData.user._id),
            variant: 'info' as const
          },
          ...(menuData.user.totpEnabled ? [{
            label: 'Reset 2FA',
            icon: ShieldOff,
            onClick: () => handle2FAResetClick(menuData.user),
            variant: 'warning' as const
          }] : []),
          ...(menuData.user.isActive !== false ? [{
            label: 'Deactivate User',
            icon: XCircle,
            onClick: () => handleDeleteUser(menuData.user),
            variant: 'danger' as const
          }] : [
            {
              label: 'Reactivate User',
              icon: CheckCircle,
              onClick: () => handleReactivateUser(menuData.user),
              variant: 'success' as const
            },
            {
              label: 'Delete Permanently',
              icon: Trash2,
              onClick: () => handlePermanentDeleteUser(menuData.user),
              variant: 'danger' as const
            }
          ])
        ] : []}
      />
    </AdminLayout >
  );
}
