export const LEAD_PRESETS = [100, 125, 150, 200, 250] as const;

export function isValidLeadCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

export function leadGuidance(count: number) {
  if (!isValidLeadCount(count)) return null;
  if (count >= 50) return { tone: "green", title: "Built for momentum", description: "Your widest pool of opportunities. Put a consistent follow-up plan behind it." };
  if (count >= 25) return { tone: "lime", title: "A stronger pipeline", description: "More conversations to work with and more opportunities to find the right fit." };
  if (count >= 15) return { tone: "amber", title: "Build your momentum", description: "A broader starting point to learn what works and build on each conversation." };
  if (count >= 10) return { tone: "amber", title: "More room to connect", description: "Give your team more opportunities to turn an introduction into a conversation." };
  if (count >= 5) return { tone: "orange", title: "Start building opportunity", description: "A small batch to test your approach. Follow up with every lead to make it count." };
  return { tone: "red", title: "Limited opportunity", description: "A small sample leaves little room for success. Consider more leads to give your outreach more chances." };
}
