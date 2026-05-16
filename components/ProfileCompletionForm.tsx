'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { User, Phone, Building, MapPin, Save, AlertCircle, CreditCard } from 'lucide-react';
import Button from './Button';
import Input from './Input';
import Card from './Card';
import toast from 'react-hot-toast';
import { safeLocalStorage } from '@/lib/storage';

interface ProfileCompletionFormProps {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  onComplete?: () => void;
}

export default function ProfileCompletionForm({ user, onComplete }: ProfileCompletionFormProps) {
  const [formData, setFormData] = useState({
    phone: '',
    phoneCc: '+91',
    companyName: '',
    gstNumber: '',
    address: {
      line1: '',
      city: '',
      state: '',
      country: 'IN',
      zipcode: '',
    },
  });
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const token = safeLocalStorage.getItem('token');

      // Ensure phoneCc and country are set for India-only service
      const profileData = {
        ...formData,
        phoneCc: '+91', // Always set to India
        address: {
          ...formData.address,
          country: 'IN' // Always set to India
        }
      };

      const response = await fetch('/api/v1/user/complete-profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(profileData),
      });

      const data = await response.json();

      if (response.ok) {
        // Update localStorage with the updated user data
        const updatedUserData = {
          ...JSON.parse(safeLocalStorage.getItem('user') || '{}'),
          ...data.user
        };
        safeLocalStorage.setItem('user', JSON.stringify(updatedUserData));

        // Trigger a custom event to notify other components of profile update
        window.dispatchEvent(new CustomEvent('profileUpdated', {
          detail: { user: updatedUserData, isComplete: true }
        }));

        toast.success('Profile completed successfully!');
        onComplete?.();
        // Redirect to checkout or dashboard
        const urlParams = new URLSearchParams(window.location.search);
        const returnUrl = urlParams.get('returnUrl');
        router.push(returnUrl || '/dashboard');
      } else {
        toast.error(data.error || 'Failed to complete profile');
      }
    } catch (error) {
      // Profile completion error
      toast.error('An error occurred. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;

    if (name.startsWith('address.')) {
      const addressField = name.split('.')[1];
      setFormData(prev => ({
        ...prev,
        address: {
          ...prev.address,
          [addressField]: value,
        },
      }));
    } else {
      setFormData(prev => ({
        ...prev,
        [name]: value,
      }));
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-2xl w-full space-y-8">
        <div className="text-center">
          <h2 className="text-3xl font-bold text-gray-900">
            Complete Your Profile
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            We need some additional information to process your domain bookings
          </p>
        </div>

        <Card>
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-center">
              <AlertCircle className="h-5 w-5 text-blue-600 mr-2" />
              <p className="text-blue-800 text-sm font-medium">
                This information is required for domain registration and billing purposes.
              </p>
            </div>
          </div>

          <form className="space-y-6" onSubmit={handleSubmit}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  First Name
                </label>
                <Input
                  value={user.firstName}
                  disabled
                  fullWidth
                  icon={<User className="h-4 w-4 text-gray-400" />}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Last Name
                </label>
                <Input
                  value={user.lastName}
                  disabled
                  fullWidth
                  icon={<User className="h-4 w-4 text-gray-400" />}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Email
              </label>
              <Input
                value={user.email}
                disabled
                fullWidth
                icon={<User className="h-4 w-4 text-gray-400" />}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Country Code
                </label>
                <div className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm bg-gray-50 text-gray-700 font-medium">
                  🇮🇳 +91 (India)
                </div>
                <input type="hidden" name="phoneCc" value="+91" />
              </div>
              <div className="md:col-span-2">
                <Input
                  label="Phone Number"
                  name="phone"
                  type="tel"
                  placeholder="Enter your phone number"
                  value={formData.phone}
                  onChange={handleChange}
                  required
                  fullWidth
                  icon={<Phone className="h-4 w-4 text-gray-400" />}
                />
              </div>
            </div>

            <Input
              label="Company Name"
              name="companyName"
              type="text"
              placeholder="Enter your company name"
              value={formData.companyName}
              onChange={handleChange}
              required
              fullWidth
              icon={<Building className="h-4 w-4 text-gray-400" />}
            />

            <Input
              label="GST Number (Optional)"
              name="gstNumber"
              type="text"
              placeholder="Enter GSTIN (if applicable)"
              value={formData.gstNumber}
              onChange={(e) => setFormData(prev => ({ ...prev, gstNumber: e.target.value.toUpperCase() }))}
              fullWidth
              icon={<CreditCard className="h-4 w-4 text-gray-400" />}
            />

            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900">Address Information</h3>

              <Input
                label="Address Line 1"
                name="address.line1"
                type="text"
                placeholder="Enter your address"
                value={formData.address.line1}
                onChange={handleChange}
                required
                fullWidth
                icon={<MapPin className="h-4 w-4 text-gray-400" />}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  label="City"
                  name="address.city"
                  type="text"
                  placeholder="Enter your city"
                  value={formData.address.city}
                  onChange={handleChange}
                  required
                  fullWidth
                />
                <Input
                  label="State"
                  name="address.state"
                  type="text"
                  placeholder="Enter your state"
                  value={formData.address.state}
                  onChange={handleChange}
                  required
                  fullWidth
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Country
                  </label>
                  <div className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm bg-gray-50 text-gray-700 font-medium">
                    🇮🇳 India
                  </div>
                  <input type="hidden" name="address.country" value="IN" />
                </div>
                <Input
                  label="ZIP Code"
                  name="address.zipcode"
                  type="text"
                  placeholder="Enter your ZIP code"
                  value={formData.address.zipcode}
                  onChange={handleChange}
                  required
                  fullWidth
                />
              </div>
            </div>

            <Button
              type="submit"
              loading={isLoading}
              fullWidth
              icon={<Save className="h-4 w-4" />}
            >
              {isLoading ? 'Completing Profile...' : 'Complete Profile'}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
