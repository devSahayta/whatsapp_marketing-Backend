// utils/warmupHelper.js
// Warm-up ONLY for Tier 250, 1K, and 2K

/**
 * Tiers that require warm-up
 * Only these tiers will have warm-up enabled
 */
export const WARMUP_REQUIRED_TIERS = [
  'TIER_250',
  'TIER_1K',
  'TIER_1000',
  'TIER_2K',
  'tier_250',
  'tier_1k',
  'tier_1000',
  'tier_2k'
];

/**
 * Check if a tier requires warm-up
 */
export function requiresWarmup(tier) {
  if (!tier) return false;
  
  const tierUpper = tier.toUpperCase();
  return WARMUP_REQUIRED_TIERS.some(t => t.toUpperCase() === tierUpper);
}

/**
 * Warm-up limits for specific tiers
 * ONLY Tier 250, 1K, and 2K
 */
export const TIER_WARMUP_LIMITS = {
  // Tier 250 (250/day)
  'TIER_250': [50, 150, 250],
  'tier_250': [50, 150, 250],
  
  // Tier 1K (1000/day)
  'TIER_1K': [200, 500, 1000],
  'TIER_1000': [200, 500, 1000],
  'tier_1k': [200, 500, 1000],
  'tier_1000': [200, 500, 1000],
  
  // Tier 2K (2000/day)
  'TIER_2K': [400, 1200, 2000],
  'tier_2k': [400, 1200, 2000],
};

/**
 * Get warm-up limits for a tier
 * Returns null if tier doesn't require warm-up
 */
export function getWarmupLimits(tier) {
  if (!tier) return null;
  
  // Check if tier requires warm-up
  if (!requiresWarmup(tier)) {
    console.log(`⏭️  Tier ${tier} does not require warm-up`);
    return null;
  }
  
  // Get limits for tier
  const limits = TIER_WARMUP_LIMITS[tier] || TIER_WARMUP_LIMITS[tier.toUpperCase()];
  
  if (limits) {
    console.log(`✅ Warm-up limits for ${tier}: [${limits.join(', ')}]`);
    return limits;
  }
  
  console.warn(`⚠️  Tier ${tier} requires warm-up but no limits defined`);
  return null;
}

/**
 * Initialize warm-up for an account based on tier
 * ONLY enables for Tier 250, 1K, 2K
 */
export async function initializeWarmup(supabase, account_id, tier) {
  try {
    // Check if tier requires warm-up
    if (!requiresWarmup(tier)) {
      console.log(`⏭️  Disabling warm-up for ${tier} (not required)`);
      
      // Disable warm-up for this tier
      const { error } = await supabase
        .from('whatsapp_accounts')
        .update({
          warmup_enabled: false,
          warmup_completed: true, // Mark as completed so it's never triggered
          warmup_limits: null
        })
        .eq('wa_id', account_id);
      
      if (error) {
        console.error('Error disabling warm-up:', error);
        return { success: false, error };
      }
      
      return { 
        success: true, 
        warmup_enabled: false,
        message: `Warm-up disabled for ${tier}` 
      };
    }
    
    // Get warm-up limits for tier
    const warmup_limits = getWarmupLimits(tier);
    
    if (!warmup_limits) {
      return { 
        success: false, 
        error: `No warm-up limits defined for ${tier}` 
      };
    }
    
    // Enable warm-up
    const { error } = await supabase
      .from('whatsapp_accounts')
      .update({
        warmup_enabled: true,
        warmup_stage: 1,
        warmup_limits: JSON.stringify(warmup_limits),
        warmup_completed: false,
        warmup_stage_progress: 0,
        warmup_last_updated_at: new Date().toISOString()
      })
      .eq('wa_id', account_id);
    
    if (error) {
      console.error('Error enabling warm-up:', error);
      return { success: false, error };
    }
    
    console.log(`✅ Warm-up enabled for ${tier}: [${warmup_limits.join(', ')}]`);
    return { 
      success: true, 
      warmup_enabled: true,
      warmup_limits,
      message: `Warm-up enabled for ${tier}` 
    };
    
  } catch (error) {
    console.error('Error in initializeWarmup:', error);
    return { success: false, error: error.message };
  }
}

export default {
  requiresWarmup,
  getWarmupLimits,
  initializeWarmup,
  WARMUP_REQUIRED_TIERS,
  TIER_WARMUP_LIMITS
};