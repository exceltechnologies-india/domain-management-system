import { CheckCircle, Clock, Globe, Server, Mail } from 'lucide-react';

interface OrderTimelineProps {
  hasDomains: boolean;
  hasHosting: boolean;
  userEmail: string;
}

interface TimelineStep {
  icon: React.ReactNode;
  title: string;
  timing: string;
  detail: string;
  status: 'instant' | 'fast' | 'slow';
}

export default function OrderTimeline({ hasDomains, hasHosting, userEmail }: OrderTimelineProps) {
  const steps: TimelineStep[] = [
    {
      icon: <CheckCircle className="h-4 w-4" />,
      title: 'Payment confirmed',
      timing: 'Instantly',
      detail: 'Your payment is securely processed by Razorpay.',
      status: 'instant',
    },
    ...(hasHosting
      ? [
          {
            icon: <Server className="h-4 w-4" />,
            title: 'Hosting account set up',
            timing: '2–5 minutes',
            detail: 'Your hosting account is created and credentials sent to you.',
            status: 'fast' as const,
          },
        ]
      : []),
    ...(hasDomains
      ? [
          {
            icon: <Globe className="h-4 w-4" />,
            title: 'Domain registered',
            timing: 'Up to 24 hours',
            detail: 'Domain registration is submitted to the registry. Most complete within minutes.',
            status: 'slow' as const,
          },
        ]
      : []),
    {
      icon: <Mail className="h-4 w-4" />,
      title: 'Confirmation email',
      timing: 'Within minutes',
      detail: `Full details and next steps sent to ${userEmail}.`,
      status: 'fast',
    },
  ];

  const statusColor: Record<TimelineStep['status'], string> = {
    instant: 'bg-emerald-soft text-emerald-ink',
    fast: 'bg-primary-100 text-primary-700',
    slow: 'bg-amber-soft text-amber-ink',
  };

  const dotColor: Record<TimelineStep['status'], string> = {
    instant: 'bg-emerald',
    fast: 'bg-primary-500',
    slow: 'bg-amber',
  };

  return (
    <div className="mt-4 px-6 pb-6">
      <div className="border border-hairline rounded-lg p-4">
        <h3 className="text-sm font-semibold text-ink mb-4 flex items-center gap-2">
          <Clock className="h-4 w-4 text-ink-3" />
          What happens after you pay
        </h3>
        <ol className="space-y-3">
          {steps.map((step, i) => (
            <li key={i} className="flex items-start gap-3">
              {/* Step dot + connector */}
              <div className="flex flex-col items-center pt-0.5 flex-shrink-0">
                <div className={`w-2 h-2 rounded-full mt-1 ${dotColor[step.status]}`} />
                {i < steps.length - 1 && (
                  <div className="w-px flex-1 bg-hairline mt-1" style={{ minHeight: '20px' }} />
                )}
              </div>
              {/* Content */}
              <div className="pb-3 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-ink">{step.title}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${statusColor[step.status]}`}>
                    {step.timing}
                  </span>
                </div>
                <p className="text-xs text-ink-3 leading-relaxed">{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
