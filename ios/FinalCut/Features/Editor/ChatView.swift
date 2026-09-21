import SwiftUI

struct ChatView: View {
    var messages: [ChatMessage]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if messages.isEmpty {
                        Text("Describe an edit — results stream from `/api/chat` (server FFmpeg).")
                            .font(.footnote)
                            .foregroundStyle(AppTheme.textSecondary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 24)
                    }
                    ForEach(messages) { message in
                        messageBubble(message)
                            .id(message.id)
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
                Text(message.content)
                    .font(.body)
                    .foregroundStyle(AppTheme.textPrimary)
                    .padding(12)
                    .background(bubbleColor(for: message.role))
                    .clipShape(RoundedRectangle(cornerRadius: AppTheme.cornerRadius))

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
        ChatMessage(role: .user, content: "Add captions"),
        ChatMessage(role: .assistant, content: "Sure — generating on server…")
    ])
}
