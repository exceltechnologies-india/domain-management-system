'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  Globe,
  FileText,
  Settings,
  LogOut,
  Menu,
  X,
  Shield
} from 'lucide-react';

interface AdminLayoutProps {
  children: React.ReactNode;
  user: {
    firstName: string;
    lastName: string;
    role: string;
  } | null;
  onLogout?: () => void;
}

export default function AdminLayout({ children, user, onLogout }: AdminLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();

  const navigation = [
    { name: 'Dashboard', href: '/admin/dashboard', icon: LayoutDashboard },
    { name: 'Users', href: '/admin/user-management', icon: Users },
    { name: 'Domains', href: '/admin/domains', icon: Globe },
    { name: 'Invoices', href: '/admin/invoices', icon: FileText },
    { name: 'Payments', href: '/admin/payment-management', icon: FileText },
    { name: 'Settings', href: '/admin/system-settings', icon: Settings },
  ];

  const isActive = (href: string) => {
    if (href === '/admin/dashboard') {
      return pathname === '/admin/dashboard' || pathname === '/admin';
    }
    if (href === '/admin/domains') {
      return pathname.startsWith('/admin/domains') || pathname.startsWith('/admin/dns-management');
    }
    return pathname.startsWith(href);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black bg-opacity-50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-72 shadow-xl transform transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:inset-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        style={{ backgroundColor: '#ffffff' }}
      >
        {/* Sidebar Header */}
        <div className="flex items-center justify-between h-16 px-6 bg-gradient-to-r from-blue-600 to-blue-700">
          <div className="flex items-center">
            <div className="p-2 bg-white bg-opacity-20 rounded-lg">
              <Shield className="h-6 w-6 text-white" />
            </div>
            <span className="ml-3 text-xl font-bold text-white">Admin Panel</span>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden text-white hover:text-gray-200 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="mt-6 px-4">
          <div className="space-y-1">
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={`flex items-center px-4 py-3 text-sm font-medium rounded-xl transition-all duration-200 group ${isActive(item.href)
                    ? 'bg-blue-50 text-blue-700 border-r-2 border-blue-700'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                    }`}
                  onClick={() => setSidebarOpen(false)}
                >
                  <Icon className={`h-5 w-5 mr-3 transition-colors ${isActive(item.href) ? 'text-blue-700' : 'text-gray-400 group-hover:text-gray-600'
                    }`} />
                  {item.name}
                </Link>
              );
            })}
          </div>
        </nav>

        {/* User info at bottom */}
        <div className="absolute bottom-0 left-0 right-0 p-4 bg-gray-50 border-t border-gray-200">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <div className="h-10 w-10 bg-gradient-to-r from-blue-500 to-blue-600 rounded-full flex items-center justify-center shadow-md">
                <span className="text-sm font-semibold text-white">
                  {user?.firstName?.charAt(0)}{user?.lastName?.charAt(0)}
                </span>
              </div>
            </div>
            <div className="ml-3 flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900 truncate">
                {user?.firstName} {user?.lastName}
              </p>
              <p className="text-xs text-gray-500">Administrator</p>
            </div>
            {onLogout && (
              <button
                onClick={onLogout}
                className="ml-2 p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all duration-200"
                title="Logout"
              >
                <LogOut className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="lg:pl-72">
        {/* Top bar */}
        <div className="sticky top-0 z-30 bg-white shadow-sm border-b border-gray-200">
          <div className="flex items-center justify-between h-16 px-4 sm:px-6 lg:px-8">
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <Menu className="h-5 w-5" />
            </button>

            <div className="flex items-center space-x-4">
              <div className="hidden sm:flex items-center space-x-3">
                <div className="text-sm">
                  <p className="font-medium text-gray-900">
                    {user?.firstName} {user?.lastName}
                  </p>
                  <p className="text-gray-500">Administrator</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Page content */}
        <main className="p-4 sm:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}