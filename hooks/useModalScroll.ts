"use client";

import { useEffect } from "react";

export function useModalScroll(isOpen: boolean) {
  useEffect(() => {
    if (isOpen) {
      // Prevent body scroll when modal is open
      document.body.style.overflow = "hidden";
      // Store the current scroll position
      const scrollY = window.scrollY;
      document.body.style.position = "fixed";
      document.body.style.top = `-${scrollY}px`;
      document.body.style.width = "100%";
    } else {
      // Restore body scroll when modal is closed
      const scrollY = document.body.style.top;
      document.body.style.overflow = "";
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.width = "";
      if (scrollY) {
        window.scrollTo(0, parseInt(scrollY || "0") * -1);
      }
    }

    // Cleanup function
    return () => {
      if (isOpen) {
        document.body.style.overflow = "";
        document.body.style.position = "";
        document.body.style.top = "";
        document.body.style.width = "";
      }
    };
  }, [isOpen]);
}

export function useScrollToTop() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
}
