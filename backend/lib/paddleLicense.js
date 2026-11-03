// backend/lib/paddleLicense.js — maps Paddle subscription statuses onto the
// licence statuses lib/license.js already understands. Pure, so it's testable.

export function licenseStatusForPaddle(paddleStatus) {
    switch (paddleStatus) {
        case 'active':
        case 'trialing':
            return 'active';
        case 'past_due':
            return 'past_due';
        case 'canceled':
        case 'paused':
            return 'cancelled';
        default:
            return null; // unknown status: leave the licence alone
    }
}
