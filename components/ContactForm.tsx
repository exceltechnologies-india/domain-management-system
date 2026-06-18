'use client';

import { useState } from 'react';
import { Send, Mail, Phone, MapPin } from 'lucide-react';
import Button from './Button';
import Input from './Input';
import Textarea from './Textarea';
import Card from './Card';
import toast from 'react-hot-toast';
import { showSuccessToast, showErrorToast } from '@/lib/toast';
import { apiClient } from '@/lib/api-client';

interface ContactFormProps {
  className?: string;
}

export default function ContactForm({ className = '' }: ContactFormProps) {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    subject: '',
    message: '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    const result = await apiClient.post('/api/v1/contact', { ...formData });

    if (result.ok) {
      setIsSubmitted(true);
      showSuccessToast('Message sent successfully!');
      setFormData({ name: '', email: '', subject: '', message: '' });
    } else {
      showErrorToast(result.error.message || 'Failed to send message');
    }
    setIsSubmitting(false);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  if (isSubmitted) {
    return (
      <Card className={`text-center ${className}`}>
        <div className="flex justify-center mb-4">
          <div className="bg-green-100 rounded-full p-3">
            <Send className="h-8 w-8 text-green-600" />
          </div>
        </div>
        <h3 className="text-xl font-semibold text-gray-900 mb-2">Message Sent!</h3>
        <p className="text-gray-600 mb-4">
          Thank you for your message. We'll get back to you within 24 hours.
        </p>
        <Button
          onClick={() => setIsSubmitted(false)}
          variant="outline"
        >
          Send Another Message
        </Button>
      </Card>
    );
  }

  return (
    <Card className={className}>
      <div className="mb-6">
        <h3 className="text-2xl font-bold text-gray-900 mb-2">Send us a message</h3>
        <p className="text-gray-600 text-sm">
          Fill out the form below and we'll get back to you as soon as possible.
        </p>
      </div>
      <div 
        className="space-y-5"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            void handleSubmit(e as unknown as React.FormEvent);
          }
        }}
      >
        <div className="grid md:grid-cols-2 gap-5">
          <Input
            label="Name"
            name="name"
            placeholder="Enter your full name"
            value={formData.name}
            onChange={handleChange}
            required
            fullWidth
            icon={<span className="text-gray-400">👤</span>}
          />
          <Input
            label="Email"
            name="email"
            type="email"
            placeholder="Enter your email address"
            value={formData.email}
            onChange={handleChange}
            required
            fullWidth
            icon={<Mail className="h-4 w-4 text-gray-400" />}
          />
        </div>

        <Input
          label="Subject"
          name="subject"
          placeholder="What is this about?"
          value={formData.subject}
          onChange={handleChange}
          required
          fullWidth
        />

        <Textarea
          label="Message"
          name="message"
          placeholder="Please describe your inquiry in detail..."
          value={formData.message}
          onChange={handleChange}
          required
          rows={4}
          fullWidth
          helperText="Please provide as much detail as possible"
        />

        <Button
          type="button"
          onClick={handleSubmit}
          loading={isSubmitting}
          fullWidth
          icon={<Send className="h-4 w-4" />}
          className="mt-2"
        >
          {isSubmitting ? 'Sending...' : 'Send Message'}
        </Button>
      </div>
    </Card>
  );
}
