# FinalCut — Export compliance

## Answer for standard HTTPS-only builds

**Does your app use encryption?** Yes (HTTPS).  
**Is it exempt?** Yes — only standard HTTPS / OS cryptography.  
**ITSAppUsesNonExemptEncryption:** `NO`

### Xcode (GENERATE_INFOPLIST_FILE)

Add to the FinalCut target (Debug + Release):

```
INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO;
```

Or Info.plist key:

```xml
<key>ITSAppUsesNonExemptEncryption</key>
<false/>
```

## TestFlight

If ASC still shows **Missing Compliance**:

1. Open the build → Export Compliance → “Uses non-exempt encryption” → **No**.  
2. Or run an ASC API workflow (Photo Recipes pattern: clear by `CFBundleVersion`) once secrets exist — do not commit `.p8` keys.

## When to re-answer

Revisit if you add custom crypto, VPN, or non-HTTPS ciphers. Document the change here.
