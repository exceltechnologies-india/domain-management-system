'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Search, Filter, MoreVertical, Trash2, Eye, EyeOff, RefreshCw, Key, UserCheck, XCircle, CheckCircle, Server, Shield, Unlock, ShieldOff, Users, UserX, Cog, ExternalLink } from 'lucide-react';
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

interface User {
  _id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  createdAt: string;
  isActive?: boolean;
  hostingCreatedAt?: string;
  hostingExpiresAt?: string;
  totpEnabled?: boolean;
}

export default function AdminUsers() {
  const [user, setUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [deactivatedUsers, setDeactivatedUsers] = useState<User[]>([]);
  const [serviceUsers, setServiceUsers] = useState<User[]>([]);
  const [activeTab, setActiveTab] = useState<'active' | 'deactivated' | 'services'>('active');

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
    const [activeResult, deactivatedResult, servicesResult] = await Promise.all([
      apiClient.get<{ users?: User[] }>('/api/v1/admin/users'),
      apiClient.get<{ users?: User[] }>('/api/v1/admin/users/deactivated'),
      apiClient.get<{ users?: User[] }>('/api/v1/admin/users/services'),
    ]);

    setUsers(activeResult.ok ? (activeResult.data.users ?? []) : []);
    setDeactivatedUsers(deactivatedResult.ok ? (deactivatedResult.data.users ?? []) : []);
    if (servicesResult.ok) {
      setServiceUsers(servicesResult.data.users ?? []);
    } else {
      logger.warn('Failed to fetch service users:', servicesResult.error.message);
      setServiceUsers([]);
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
      serviceUsers.find(u => u._id === userId);
    if (userToView) {
      setSelectedUser(userToView);
      setIsModalOpen(true);
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

    const result = await apiClient.post<{ emailSent?: boolean }>('/api/v1/admin/users/reset-password', {
      userId: passwordResetUser._id,
      newPassword,
      sendEmail: sendEmailNotification,
    });

    if (result.ok) {
      showSuccessToast(
        `Password reset successfully. ${result.data.emailSent ? 'Email sent to user.' : 'Email notification was not sent.'}`
      );
      setIsPasswordResetModalOpen(false);
      setPasswordResetUser(null);
      setNewPassword('');
      setConfirmPassword('');
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
          <div className="text-xs sm:text-sm font-medium text-gray-900">
            {row.firstName} {row.lastName}
          </div>
          <div className="text-xs sm:text-sm text-gray-500 truncate max-w-[150px] sm:max-w-none">{row.email}</div>
        </div>
      )
    },
    {
      key: 'role',
      label: 'Role',
      sortable: true,
      render: (value: string) => (
        <span className="px-1.5 sm:px-2 py-0.5 sm:py-1 text-[10px] sm:text-xs font-medium rounded-full bg-blue-100 text-blue-800">
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
          <span className={`px-1.5 sm:px-2 py-0.5 sm:py-1 text-[10px] sm:text-xs font-medium rounded-full w-fit ${row.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
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
          return <span className="text-xs sm:text-sm text-gray-400">-</span>;
        }

        const date = new Date(value);
        if (isNaN(date.getTime())) {
          return <span className="text-xs sm:text-sm text-gray-400">-</span>;
        }

        return (
          <span className="text-xs sm:text-sm text-gray-600">
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
          className={`p-2 rounded-lg transition-all duration-200 ${menuData?.id === row._id ? 'bg-blue-100 text-blue-600' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
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
          <div className="text-xs sm:text-sm font-medium text-gray-900">
            {row.firstName} {row.lastName}
          </div>
          <div className="text-xs sm:text-sm text-gray-500 truncate max-w-[150px] sm:max-w-none">{row.email}</div>
        </div>
      )
    },
    {
      key: 'role',
      label: 'Role',
      sortable: true,
      render: (value: string) => (
        <span className="px-1.5 sm:px-2 py-0.5 sm:py-1 text-[10px] sm:text-xs font-medium rounded-full bg-blue-100 text-blue-800">
          user
        </span>
      )
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (_value: unknown, row: User) => (
        <span className="px-1.5 sm:px-2 py-0.5 sm:py-1 text-[10px] sm:text-xs font-medium rounded-full bg-red-100 text-red-800">
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
          return <span className="text-xs sm:text-sm text-gray-400">-</span>;
        }

        const date = new Date(value);
        if (isNaN(date.getTime())) {
          return <span className="text-xs sm:text-sm text-gray-400">-</span>;
        }

        return (
          <span className="text-xs sm:text-sm text-gray-900">
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
          className={`p-2 rounded-lg transition-all duration-200 ${menuData?.id === row._id ? 'bg-blue-100 text-blue-600' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
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
          <div className="text-xs sm:text-sm font-medium text-gray-900">
            {row.firstName} {row.lastName}
          </div>
          <div className="text-xs sm:text-sm text-gray-500 truncate max-w-[150px] sm:max-w-none">{row.email}</div>
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
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
              <span className="text-xs text-gray-700">
                {row.domains.length} Domain{row.domains.length !== 1 ? 's' : ''}
              </span>
              <span className="text-[10px] text-gray-400">({row.domains[0].domainName})</span>
            </div>
          )}
          {row.hosting && row.hosting.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-purple-500"></span>
              <span className="text-xs text-gray-700">
                {row.hosting.length} Hosting
              </span>
              <span className="text-[10px] text-gray-400">({row.hosting[0].name})</span>
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
        <span className={`px-1.5 sm:px-2 py-0.5 sm:py-1 text-[10px] sm:text-xs font-medium rounded-full ${row.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
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
        <span className="text-xs sm:text-sm text-gray-600">
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
          className={`p-2 rounded-lg transition-all duration-200 ${menuData?.id === row._id ? 'bg-blue-100 text-blue-600' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
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
            <div className="p-2 bg-blue-50 rounded-xl">
              <Users className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">User Management</h1>
              <p className="text-sm text-gray-500 mt-0.5">Manage user accounts and permissions</p>
            </div>
          </div>
          <RefreshButton onClick={loadUsers} isLoading={isDataLoading} />
        </div>

        {/* ── Summary stat cards ── */}
        {!isDataLoading && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <button
              onClick={() => setActiveTab('active')}
              className={`bg-white border rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3 text-left transition-all ${activeTab === 'active' ? 'border-blue-300 ring-2 ring-blue-100' : 'border-gray-200 hover:border-gray-300 hover:shadow-md'}`}
            >
              <div className="p-2 bg-green-50 rounded-xl">
                <UserCheck className="h-4 w-4 text-green-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-gray-500">Active Users</p>
                <p className="text-xl font-bold text-gray-900">{users.length}</p>
              </div>
            </button>
            <button
              onClick={() => setActiveTab('deactivated')}
              className={`bg-white border rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3 text-left transition-all ${activeTab === 'deactivated' ? 'border-blue-300 ring-2 ring-blue-100' : 'border-gray-200 hover:border-gray-300 hover:shadow-md'}`}
            >
              <div className="p-2 bg-red-50 rounded-xl">
                <UserX className="h-4 w-4 text-red-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-gray-500">Deactivated</p>
                <p className="text-xl font-bold text-gray-900">{deactivatedUsers.length}</p>
              </div>
            </button>
            <button
              onClick={() => setActiveTab('services')}
              className={`bg-white border rounded-2xl shadow-sm px-5 py-4 flex items-center gap-3 text-left transition-all ${activeTab === 'services' ? 'border-blue-300 ring-2 ring-blue-100' : 'border-gray-200 hover:border-gray-300 hover:shadow-md'}`}
            >
              <div className="p-2 bg-purple-50 rounded-xl">
                <Cog className="h-4 w-4 text-purple-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-gray-500">Service Users</p>
                <p className="text-xl font-bold text-gray-900">{serviceUsers.length}</p>
              </div>
            </button>
          </div>
        )}

        {/* ── Users card ── */}
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
          {/* Card header — segmented tabs */}
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/60 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2.5">
              <Users className="h-4 w-4 text-gray-500" />
              <h3 className="text-sm font-semibold text-gray-900">
                {activeTab === 'active' && 'Active Users'}
                {activeTab === 'deactivated' && 'Deactivated Users'}
                {activeTab === 'services' && 'Service Users'}
              </h3>
            </div>
            <div className="inline-flex bg-gray-100 rounded-xl p-1">
              {[
                { id: 'active',      label: 'Active',      count: users.length },
                { id: 'deactivated', label: 'Deactivated', count: deactivatedUsers.length },
                { id: 'services',    label: 'Services',    count: serviceUsers.length },
              ].map(t => (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id as 'active' | 'deactivated' | 'services')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    activeTab === t.id
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {t.label} <span className={`ml-1 ${activeTab === t.id ? 'text-blue-600' : 'text-gray-400'}`}>({t.count})</span>
                </button>
              ))}
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
                <label className="text-sm font-medium text-gray-500">Full Name</label>
                <p className="text-lg font-semibold text-gray-900">
                  {selectedUser.firstName} {selectedUser.lastName}
                </p>
              </div>

              <div>
                <label className="text-sm font-medium text-gray-500">Email Address</label>
                <p className="text-lg font-semibold text-gray-900">{selectedUser.email}</p>
              </div>

              <div>
                <label className="text-sm font-medium text-gray-500">Role</label>
                <span className="inline-flex px-2 py-1 text-xs font-medium rounded-full bg-blue-100 text-blue-800">
                  {selectedUser.role}
                </span>
              </div>

              <div>
                <label className="text-sm font-medium text-gray-500">Account Status</label>
                <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${selectedUser.isActive
                  ? 'bg-green-100 text-green-800'
                  : 'bg-red-100 text-red-800'
                  }`}>
                  {selectedUser.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>

              <div>
                <label className="text-sm font-medium text-gray-500">Registration Date</label>
                <p className="text-lg font-semibold text-gray-900">
                  {formatIndianLongDateTime(selectedUser.createdAt)}
                </p>
              </div>


            </div>

            <div className="mt-6 flex justify-end space-x-3">
              <button
                onClick={() => setIsModalOpen(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <div className="text-center py-4">
            <p className="text-gray-500">No user selected</p>
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
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <div className="flex">
                <div className="flex-shrink-0">
                  <div className="w-5 h-5 bg-yellow-400 rounded-full flex items-center justify-center">
                    <span className="text-yellow-800 text-xs font-bold">!</span>
                  </div>
                </div>
                <div className="ml-3">
                  <h3 className="text-sm font-medium text-yellow-800">
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    New Password
                  </label>
                  <div className="relative">
                    <input
                      type={showNewPassword ? "text" : "password"}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Enter new password (min 6 characters)"
                      className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword(!showNewPassword)}
                      className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 hover:text-gray-600 focus:outline-none"
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Confirm Password
                  </label>
                  <div className="relative">
                    <input
                      type={showConfirmPassword ? "text" : "password"}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Confirm new password"
                      className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 hover:text-gray-600 focus:outline-none"
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

                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="sendEmail"
                    checked={sendEmailNotification}
                    onChange={(e) => setSendEmailNotification(e.target.checked)}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <label htmlFor="sendEmail" className="ml-2 block text-sm text-gray-700">
                    Send email notification to user with new password
                  </label>
                </div>

                <div className="mt-6 flex justify-end space-x-3">
                  <button
                    type="button"
                    onClick={handlePasswordResetCancel}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isResettingPassword}
                    className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
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
            <p className="text-gray-500">No user selected</p>
          </div>
        )
        }
      </Modal >

      {/* Deactivate User Confirmation Modal */}
      {
        isDeactivateModalOpen && userToDeactivate && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full">
              <div className="p-6">
                <div className="flex items-center mb-4">
                  <div className="flex-shrink-0">
                    <XCircle className="h-6 w-6 text-red-600" />
                  </div>
                  <div className="ml-3">
                    <h3 className="text-lg font-medium text-gray-900">
                      Deactivate User
                    </h3>
                  </div>
                </div>

                <div className="mb-6">
                  <p className="text-gray-700 mb-2">
                    Are you sure you want to deactivate this user? They will not be able to log in but their data will be preserved.
                  </p>
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="text-sm">
                      <div className="font-medium text-gray-900">
                        {userToDeactivate.firstName} {userToDeactivate.lastName}
                      </div>
                      <div className="text-gray-600">
                        {userToDeactivate.email}
                      </div>
                      <div className="text-gray-600">
                        Role: {userToDeactivate.role}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end space-x-3">
                  <button
                    onClick={cancelDeactivateUser}
                    disabled={isDeactivating}
                    className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmDeactivateUser}
                    disabled={isDeactivating}
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center"
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
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full">
              <div className="p-6">
                <div className="flex items-center mb-4">
                  <div className="flex-shrink-0">
                    <CheckCircle className="h-6 w-6 text-green-600" />
                  </div>
                  <div className="ml-3">
                    <h3 className="text-lg font-medium text-gray-900">
                      Reactivate User
                    </h3>
                  </div>
                </div>

                <div className="mb-6">
                  <p className="text-gray-700 mb-2">
                    Are you sure you want to reactivate this user? They will be able to log in again.
                  </p>
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="text-sm">
                      <div className="font-medium text-gray-900">
                        {userToReactivate.firstName} {userToReactivate.lastName}
                      </div>
                      <div className="text-gray-600">
                        {userToReactivate.email}
                      </div>
                      <div className="text-gray-600">
                        Role: {userToReactivate.role}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end space-x-3">
                  <button
                    onClick={cancelReactivateUser}
                    disabled={isReactivating}
                    className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmReactivateUser}
                    disabled={isReactivating}
                    className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center"
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
            <div className="bg-white rounded-xl shadow-xl max-w-md w-full">
              <div className="p-6">
                <div className="flex items-center mb-4">
                  <div className="flex-shrink-0">
                    <Trash2 className="h-6 w-6 text-red-600" />
                  </div>
                  <div className="ml-3">
                    <h3 className="text-lg font-medium text-gray-900">
                      Permanently Delete User
                    </h3>
                  </div>
                </div>

                <div className="mb-6">
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
                    <p className="text-red-800 text-sm font-medium">
                      Warning: This action is irreversible!
                    </p>
                    <p className="text-red-700 text-sm mt-1">
                      All user data, including services and history, will be permanently removed.
                    </p>
                  </div>
                  <p className="text-gray-700 mb-2">
                    Are you sure you want to permanently delete this user?
                  </p>
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="text-sm">
                      <div className="font-medium text-gray-900">
                        {userToPermanentlyDelete.firstName} {userToPermanentlyDelete.lastName}
                      </div>
                      <div className="text-gray-600">
                        {userToPermanentlyDelete.email}
                      </div>
                      <div className="text-gray-600">
                        Role: {userToPermanentlyDelete.role}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end space-x-3">
                  <button
                    onClick={cancelPermanentDeleteUser}
                    disabled={isPermanentlyDeleting}
                    className="px-4 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmPermanentDeleteUser}
                    disabled={isPermanentlyDeleting}
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center"
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
            <div className="flex items-center gap-4 border-b border-gray-100 pb-4">
              <div className="h-12 w-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-bold text-lg">
                {selectedServiceUser.firstName?.charAt(0)}
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900">
                  {selectedServiceUser.firstName} {selectedServiceUser.lastName}
                </h3>
                <p className="text-sm text-gray-500">{selectedServiceUser.email}</p>
                {selectedServiceUser.directAdminUsername && (
                  <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded mt-1 inline-block">
                    DA User: {selectedServiceUser.directAdminUsername}
                  </span>
                )}
              </div>
            </div>

            {/* Hosting Section */}
            <div>
              <h4 className="flex items-center gap-2 text-sm font-bold text-gray-900 uppercase tracking-wider mb-3">
                <Server className="h-4 w-4 text-purple-600" /> Hosting Services
              </h4>
              {selectedServiceUser.hosting && selectedServiceUser.hosting.length > 0 ? (
                <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                  <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Package</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Domain</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Expires</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Manage</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {selectedServiceUser.hosting.map((host: NonNullable<ServiceUser['hosting']>[number], i: number) => (
                        <tr key={i}>
                          <td className="px-4 py-3 text-sm font-medium text-gray-900">{host.name || 'Standard Hosting'}</td>
                          <td className="px-4 py-3 text-sm text-gray-500">{host.domainName}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-1 text-xs font-medium rounded-full ${host.status === 'active' ? 'bg-green-100 text-green-800' :
                              host.status === 'suspended' ? 'bg-orange-100 text-orange-800' :
                                host.status === 'terminated' || host.status === 'expired' ? 'bg-red-100 text-red-800' :
                                  'bg-gray-100 text-gray-800'
                              }`}>
                              {host.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500">
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
                              <span className="text-xs text-gray-400">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-gray-500 italic bg-gray-50 p-4 rounded-lg text-center">No hosting services found.</div>
              )}
            </div>

            {/* Domains Section */}
            <div>
              <h4 className="flex items-center gap-2 text-sm font-bold text-gray-900 uppercase tracking-wider mb-3">
                <div className="h-4 w-4 bg-blue-500 rounded-full flex items-center justify-center text-[8px] text-white">D</div> Domains
              </h4>
              {selectedServiceUser.domains && selectedServiceUser.domains.length > 0 ? (
                <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                  <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Domain Name</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Expires</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {selectedServiceUser.domains.map((domain: NonNullable<ServiceUser['domains']>[number], i: number) => (
                        <tr key={i}>
                          <td className="px-4 py-3 text-sm font-medium text-gray-900">{domain.domainName}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-1 text-xs font-medium rounded-full ${domain.status === 'registered' || domain.status === 'active' ? 'bg-green-100 text-green-800' :
                              domain.status === 'expired' ? 'bg-red-100 text-red-800' :
                                domain.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                                  'bg-gray-100 text-gray-800'
                              }`}>
                              {domain.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500">
                            {domain.expiryDate ? formatIndianDate(new Date(domain.expiryDate)) : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-gray-500 italic bg-gray-50 p-4 rounded-lg text-center">No registered domains found.</div>
              )}
            </div>

          </div>
        )}
      </Modal>

      {/* 2FA Reset Confirmation Modal */}
      {is2FAResetModalOpen && userToReset2FA && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-orange-100 rounded-full flex items-center justify-center flex-shrink-0">
                <ShieldOff className="h-5 w-5 text-orange-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Reset 2FA</h3>
                <p className="text-sm text-gray-500">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-sm text-gray-700 mb-2">
              You are about to disable two-factor authentication for:
            </p>
            <div className="bg-gray-50 rounded-lg px-4 py-3 mb-4">
              <p className="text-sm font-semibold text-gray-900">{userToReset2FA.firstName} {userToReset2FA.lastName}</p>
              <p className="text-xs text-gray-500">{userToReset2FA.email}</p>
            </div>
            <p className="text-sm text-gray-600 mb-6">
              Their current session will be invalidated and they will need to log in again. They can set up 2FA again from their security settings.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={cancel2FAReset}
                disabled={isResetting2FA}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50"
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
