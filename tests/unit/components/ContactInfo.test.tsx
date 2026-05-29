/**
 * Component tests for <ContactInfo> (rescan-4 M14).
 * Pure presentational — pins the three contact cards (call/email/visit)
 * each rendering its heading + the contact value + a context line.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import ContactInfo from "@/components/ContactInfo";

describe("<ContactInfo>", () => {
  it("renders the 'Get in touch' intro heading + description", () => {
    render(<ContactInfo />);
    expect(screen.getByRole("heading", { name: /get in touch/i })).toBeInTheDocument();
    expect(screen.getByText(/have questions about our domain management services/i)).toBeInTheDocument();
  });

  it("renders the call card with phone number and the IST business hours", () => {
    render(<ContactInfo />);
    expect(screen.getByRole("heading", { name: /call us/i })).toBeInTheDocument();
    expect(screen.getByText("+91-777-888-9674")).toBeInTheDocument();
    expect(screen.getByText(/10am to 6pm \(ist\)/i)).toBeInTheDocument();
  });

  it("renders the email card with sales address and the 24h response copy", () => {
    render(<ContactInfo />);
    expect(screen.getByRole("heading", { name: /email us/i })).toBeInTheDocument();
    expect(screen.getByText("sales@anutech.in")).toBeInTheDocument();
    expect(screen.getByText(/respond within 24 hours/i)).toBeInTheDocument();
  });

  it("renders the visit card with the Rohini address", () => {
    render(<ContactInfo />);
    expect(screen.getByRole("heading", { name: /visit us/i })).toBeInTheDocument();
    expect(screen.getByText(/b9-54, rohini/i)).toBeInTheDocument();
    expect(screen.getByText(/delhi, india/i)).toBeInTheDocument();
  });

  it("passes the className through to the outer wrapper", () => {
    const { container } = render(<ContactInfo className="my-custom-cls" />);
    expect((container.firstChild as HTMLElement).className).toContain("my-custom-cls");
  });
});
