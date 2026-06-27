'use client';

// Updated Admin Layout with clean white design and mobile responsiveness
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard,
  Users,
  FileText,
  Settings,
  LogOut,
  Menu,
  X,
  Shield,
  Package,
  Globe,
  Server,
  AlertTriangle,
  Tag,
  Activity,
  MessageCircle,
  ShieldAlert,
  RefreshCcw,
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
    { name: 'Dashboard', href: '/admin/dashboard', icon: Activity },
    { name: 'Users', href: '/admin/user-management', icon: Users },
    { name: 'Orders', href: '/admin/order-management', icon: Package },
    { name: 'Invoices', href: '/admin/invoices', icon: FileText },
    { name: 'Payments', href: '/admin/payment-management', icon: FileText },
    { name: 'Pending Domains', href: '/admin/pending-domains', icon: AlertTriangle },
    { name: 'Integration Health', href: '/admin/integration-health', icon: ShieldAlert },
    { name: 'Recurring Charges', href: '/admin/recurring-charges', icon: RefreshCcw },
    { name: 'Support Tickets', href: '/admin/support-tickets', icon: MessageCircle },
    { name: 'Hosting', href: '/admin/hosting', icon: Server },
    { name: 'Domains', href: '/admin/domains', icon: Globe },
    { name: 'TLD Pricing', href: '/admin/pricing-management', icon: Tag },
    { name: 'Settings', href: '/admin/settings', icon: Settings },
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
    <div className="h-screen bg-gray-50 flex overflow-hidden">
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
        style={{
          backgroundColor: '#ffffff',
          borderRight: '1px solid #e5e7eb'
        }}
      >
        {/* Sidebar Header */}
        <div className="flex items-center justify-between h-16 px-6 bg-gradient-to-r from-blue-600 to-blue-700 border-b border-blue-500">
          <div className="flex items-center">
            <div className="p-2 bg-white bg-opacity-20 rounded-lg">
              <Shield className="h-6 w-6 text-white" />
            </div>
            <span className="ml-3 text-xl font-bold text-white">Admin Panel</span>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation menu"
            className="lg:hidden text-white hover:text-gray-200 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="mt-6 px-4 overflow-y-auto" style={{ backgroundColor: '#ffffff', maxHeight: 'calc(100vh - 4rem)' }}>
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

      </div>

      {/* Main content */}
      <div className="flex-1 lg:ml-0 flex flex-col overflow-hidden">
        {/* Top bar - aligned with sidebar header */}
        <div className="sticky top-0 z-30 bg-white shadow-sm border-b border-gray-200 h-16 flex items-center flex-shrink-0">
          <div className="flex items-center justify-between w-full px-4 sm:px-6 lg:px-8">
            {/* Left side - Mobile menu button */}
            <button
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <Menu className="h-5 w-5" />
            </button>

            {/* Right side - Admin user info */}
            <div className="flex items-center space-x-3 ml-auto">
              {/* Admin User Info - Right aligned */}
              <div className="flex items-center space-x-3 bg-gray-50 rounded-lg px-3 py-2">
                <div className="h-8 w-8 bg-gradient-to-r from-blue-500 to-blue-600 rounded-full flex items-center justify-center shadow-sm">
                  <span className="text-xs font-semibold text-white uppercase">
                    {user?.firstName ? user.firstName.charAt(0) : 'A'}
                    {user?.lastName ? user.lastName.charAt(0) : 'U'}
                  </span>
                </div>
                <div className="hidden sm:block">
                  <p className="text-sm font-semibold text-gray-900">
                    {user?.firstName} {user?.lastName}
                  </p>
                  <p className="text-xs text-gray-500">Administrator</p>
                </div>
                {onLogout && (
                  <button
                    onClick={onLogout}
                    className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all duration-200"
                    title="Logout"
                  >
                    <LogOut className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <div className="animate-in fade-in duration-300 ease-out">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
