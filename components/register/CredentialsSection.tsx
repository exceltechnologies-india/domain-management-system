'use client';

import { useState } from 'react';
import { Eye, EyeOff, Lock } from 'lucide-react';
import Input from '../Input';
import type { RegisterFormData, RegisterChangeHandler } from './types';

interface Props {
  formData: RegisterFormData;
  onChange: RegisterChangeHandler;
}

/**
 * Password + confirm-password fields. Each owns its own show/hide toggle —
 * the parent doesn't need to know about that piece of UI state.
 */
export default function CredentialsSection({ formData, onChange }: Props) {
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  return (
    <>
      <div className="relative">
        <Input
          label="Password"
          name="password"
          type={showPassword ? 'text' : 'password'}
          placeholder="Create a strong password"
          value={formData.password}
          onChange={onChange}
          required
          fullWidth
          icon={<Lock className="h-4 w-4 text-gray-400" />}
          helperText="Min. 8 characters with uppercase, lowercase, number, and special character"
          rightIcon={
            <button
              type="button"
              className="text-gray-500 hover:text-gray-700 focus:outline-none"
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          }
        />
      </div>

      <div className="relative">
        <Input
          label="Confirm password"
          name="confirmPassword"
          type={showConfirmPassword ? 'text' : 'password'}
          placeholder="Confirm your password"
          value={formData.confirmPassword}
          onChange={onChange}
          required
          fullWidth
          icon={<Lock className="h-4 w-4 text-gray-400" />}
          rightIcon={
            <button
              type="button"
              className="text-gray-500 hover:text-gray-700 focus:outline-none"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
            >
              {showConfirmPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          }
        />
      </div>
    </>
  );
}
