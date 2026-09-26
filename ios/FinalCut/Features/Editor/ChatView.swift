import SwiftUI

struct ChatView: View {
    var messages: [ChatMessage]
    /// Retry for generic failed edit cards (resends the card's prompt).
    var onRetry: ((EditFailureCard) -> Void)? = nil
    /// User bubbles waiting behind the current edit (shown with a "Queued" label).
    var queuedIDs: Set<UUID> = []
    /// Shows a small working indicator under the last message.
    var isWorking: Bool = false

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if messages.isEmpty {
                        Text("Import a photo or video, then describe an edit — e.g. “Generate captions”.")
                            .font(.footnote)
                            .foregroundStyle(AppTheme.textSecondary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 24)
                    }
                    ForEach(messages) { message in
                        messageBubble(message)
                            .id(message.id)
                    }
                    if isWorking {
                        ProgressView()
                            .tint(AppTheme.accent)
                            .padding(.leading, 4)
                            .accessibilityIdentifier("ChatWorking")
                    }
                }
                .padding(16)
            }
            .onChange(of: messages.count) { _, _ in
                if let last = messages.last {
                    withAnimation {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
        .background(AppTheme.background)
        .accessibilityIdentifier("Chat")
    }

    @ViewBuilder
    private func messageBubble(_ message: ChatMessage) -> some View {
        HStack {
            if message.role == .user { Spacer(minLength: 40) }
            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 8) {
                if let card = message.failureCard {
                    failureCardView(card)
                } else {
                Text(message.content)
                    .font(.body)
                    .foregroundStyle(AppTheme.textPrimary)
                    .padding(12)
                    .background(bubbleColor(for: message.role))
                    .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
                    .opacity(queuedIDs.contains(message.id) ? 0.6 : 1)
                if queuedIDs.contains(message.id) {
                    Text(UXCopy.dictationQueued)
                        .font(.caption2)
                        .foregroundStyle(AppTheme.textSecondary)
                        .accessibilityIdentifier("QueuedLabel")
                }
                }

                if !message.downloadChips.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(message.downloadChips) { chip in
                                ShareLink(
                                    item: chip.content,
                                    subject: Text(chip.filename),
                                    message: Text(chip.filename),
                                    preview: SharePreview(chip.filename)
                                ) {
                                    Text(chip.label)
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(AppTheme.textPrimary)
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 6)
                                        .background(AppTheme.surfaceElevated)
                                        .clipShape(Capsule())
                                        .overlay(Capsule().stroke(AppTheme.border, lineWidth: 1))
                                }
                                .accessibilityLabel("Download \(chip.label)")
                            }
                        }
                    }
                }

                if !message.resultThumbnailURLs.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(message.resultThumbnailURLs, id: \.self) { url in
                                AsyncImage(url: url) { image in
                                    image.resizable().scaledToFill()
                                } placeholder: {
                                    RoundedRectangle(cornerRadius: 8)
                                        .fill(AppTheme.surfaceElevated)
                                }
                                .frame(width: 72, height: 72)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                        }
                    }
                }
            }
            if message.role != .user { Spacer(minLength: 40) }
        }
    }

    /// Failed edit card: fixed copy only, Retry only for generic failures.
    private func failureCardView(_ card: EditFailureCard) -> some View {
        // "Not available on iPhone yet" is informational, not an error: muted styling.
        let muted = card.kind == .unavailable
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: muted ? "iphone.slash" : "exclamationmark.triangle.fill")
                    .foregroundStyle(muted ? AppTheme.textSecondary : AppTheme.danger)
                Text(card.copy)
                    .font(.body)
                    .foregroundStyle(AppTheme.textPrimary)
            }
            if card.showsRetry, let onRetry {
                Button(UXCopy.retry) { onRetry(card) }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.accent)
                    .accessibilityIdentifier("EditFailureRetry")
            }
        }
        .padding(12)
        .background(AppTheme.surfaceElevated)
        .overlay(
            RoundedRectangle(cornerRadius: AppTheme.cornerRadius)
                .stroke(muted ? AppTheme.border : AppTheme.danger.opacity(0.6), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))
        .accessibilityIdentifier("EditFailureCard")
    }

    private func bubbleColor(for role: ChatMessage.Role) -> Color {
        switch role {
        case .user: return AppTheme.accent.opacity(0.25)
        case .assistant: return AppTheme.surfaceElevated
        case .system, .tool: return AppTheme.surface
        }
    }
}

#Preview {
    ChatView(messages: [
        ChatMessage(role: .user, content: "Generate captions"),
        ChatMessage(
            role: .assistant,
            content: "Captions ready — soft chips below.",
            downloadChips: [
                CaptionDownloadChip(label: "SRT", filename: "captions.srt", content: "1\n00:00:00,000 --> 00:00:01,000\nHi\n"),
                CaptionDownloadChip(label: "VTT", filename: "captions.vtt", content: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi\n"),
            ]
        ),
    ])
}
