'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { apiClient } from '@/lib/api-client';

export default function AdminPasswordReset() {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }

    if (newPassword.length < 8) {
      toast.error('Password must be at least 8 characters long');
      return;
    }

    setIsLoading(true);

    const result = await apiClient.post('/api/v1/admin/reset-password', {
      newPassword,
      confirmPassword,
    });

    if (result.ok) {
      toast.success('Admin password updated successfully!');
      setNewPassword('');
      setConfirmPassword('');
    } else {
      toast.error(result.error.message || 'Failed to update password');
    }
    setIsLoading(false);
  };

  return (
    <div className="max-w-md mx-auto">
      <div className="bg-paper rounded-lg shadow-md border border-hairline p-6">
        <h3 className="text-lg font-semibold text-ink mb-4">Reset Admin Password</h3>
        <p className="text-sm text-ink-2 mb-6">
          Enter a new password for the admin account.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="admin-new-password" className="block text-sm font-medium text-ink-2 mb-1">
              New Password
            </label>
            <input
              id="admin-new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 border border-hairline rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              placeholder="Enter new password"
              required
            />
          </div>

          <div>
            <label htmlFor="admin-confirm-password" className="block text-sm font-medium text-ink-2 mb-1">
              Confirm Password
            </label>
            <input
              id="admin-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 border border-hairline rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              placeholder="Confirm new password"
              required
            />
          </div>

          <button
            type="submit"
            disabled={isLoading || !newPassword || !confirmPassword || newPassword !== confirmPassword}
            className="w-full bg-primary-600 text-paper py-2 px-4 rounded-md hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Updating...' : 'Update Password'}
          </button>
        </form>
      </div>
    </div>
  );
}