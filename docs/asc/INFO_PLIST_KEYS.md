# FinalCut iOS — required Info / build keys for ASC

Target uses `GENERATE_INFOPLIST_FILE = YES`. Set these on the **FinalCut** target (project.pbxproj / Build Settings):

| Build setting / key | Value | Why |
|---------------------|-------|-----|
| `PRODUCT_BUNDLE_IDENTIFIER` | `com.grepawk.finalcut` | ASC |
| `INFOPLIST_KEY_CFBundleDisplayName` | `FinalCut` | Home screen |
| `INFOPLIST_KEY_ITSAppUsesNonExemptEncryption` | `NO` | Export compliance |
| `INFOPLIST_KEY_NSPhotoLibraryUsageDescription` | Import videos to edit in FinalCut. | Photos import |
| `INFOPLIST_KEY_NSPhotoLibraryAddUsageDescription` | Save exported videos to your library. | Export |
| `INFOPLIST_KEY_NSMicrophoneUsageDescription` | Only if in-app recording ships — else omit. | TBD |
| `INFOPLIST_KEY_NSCameraUsageDescription` | Omit unless camera capture ships. | Avoid unused private API prompts |

Also set marketing version (`MARKETING_VERSION`) and build (`CURRENT_PROJECT_VERSION`) deliberately for each TestFlight upload.

iOS engineer: apply keys in Xcode on the PR that follows this docs pack if not already present.
