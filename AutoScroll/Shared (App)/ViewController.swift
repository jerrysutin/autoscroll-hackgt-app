//
//  ViewController.swift
//  Shared (App)
//
//  Created by Jerry Sutin on 9/25/26.
//

import WebKit

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
typealias PlatformColor = UIColor
typealias PlatformFont = UIFont
#elseif os(macOS)
import Cocoa
import SafariServices
typealias PlatformViewController = NSViewController
typealias PlatformColor = NSColor
typealias PlatformFont = NSFont
#endif

let extensionBundleIdentifier = "com.autoscroll.AutoScroll.Extension"

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        #if os(iOS)
        view.backgroundColor = .systemBackground
        #elseif os(macOS)
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        #endif


        // 1. Hide the webview if it exists in Storyboard/XIB
        webView?.isHidden = true

        // 2. Build and display the UI elements directly
        setupNativeUI()
    }

    private func setupNativeUI() {
        // Main Container View
        #if os(iOS)
        let stackView = UIStackView()
        stackView.axis = .vertical
        stackView.alignment = .center
        stackView.distribution = .equalSpacing
        stackView.spacing = 16
        #elseif os(macOS)
        let stackView = NSStackView()
        stackView.orientation = .vertical
        stackView.alignment = .centerX
        stackView.distribution = .gravityAreas
        stackView.spacing = 16
        #endif

        stackView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stackView)

        // Constraint stack view to parent view bounds with padding
        NSLayoutConstraint.activate([
            stackView.topAnchor.constraint(equalTo: view.topAnchor, constant: 40),
            stackView.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -30),
            stackView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            stackView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20)
        ])

        // --- 1. Header ---
        let headerLabel = createLabel(
            text: "AutoScroll",
            font: .boldSystemFont(ofSize: 40),
            color: .labelColor
        )
        stackView.addArrangedSubview(headerLabel)

        // --- 2. Mission Statement ---
        let missionLabel = createLabel(
            text: "AutoScroll creates a hands-free way to browse short-form content.",
            font: .systemFont(ofSize: 20),
            color: .secondaryLabelColor,
            alignment: .center
        )
        stackView.addArrangedSubview(missionLabel)

        // --- 3. Extension Button ---
        #if os(iOS)
        let button = UIButton(type: .system)
        button.setTitle("Open AutoScroll Extension", for: .normal)
        button.titleLabel?.font = .boldSystemFont(ofSize: 17)
        button.setTitleColor(.white, for: .normal)
        button.backgroundColor = .systemBlue
        button.layer.cornerRadius = 12
        button.contentEdgeInsets = UIEdgeInsets(top: 14, left: 24, bottom: 14, right: 24)
        button.addTarget(self, action: #selector(openExtensionPressed), for: .touchUpInside)
        #elseif os(macOS)
        let button = NSButton(title: "Open AutoScroll Extension", target: self, action: #selector(openExtensionPressed))
        button.bezelStyle = .rounded
        button.font = .boldSystemFont(ofSize: 15)
        #endif
        stackView.addArrangedSubview(button)

        // --- 4. Camera Section ---
        let cameraBlock = createFeatureSection(
            systemImageName: "camera.fill",
            title: "Camera",
            description: "Uses your camera to capture your facial expressions while you browse."
        )
        stackView.addArrangedSubview(cameraBlock)

        // --- 5. Face Detection Section ---
        let faceBlock = createFeatureSection(
            systemImageName: "face.smiling.fill",
            title: "Face Detection",
            description: "Detects your facial expressions to understand your reactions to the content."
        )
        stackView.addArrangedSubview(faceBlock)

        // --- 6. Auto Scroll Section ---
        let scrollBlock = createFeatureSection(
            systemImageName: "arrow.down.circle.fill",
            title: "Auto Scroll",
            description: "Uses your reactions to decide when to automatically scroll to the next video."
        )
        stackView.addArrangedSubview(scrollBlock)

        // --- 7. Footer ---
        let footerLabel = createLabel(
            text: "Control your scrolling without touching your screen.",
            font: .systemFont(ofSize: 12),
            color: .secondaryLabelColor,
            alignment: .center
        )
        stackView.addArrangedSubview(footerLabel)
    }

    // MARK: - Action

    @objc private func openExtensionPressed() {
        #if os(macOS)
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            if let error = error {
                print("Could not open Safari Extension preferences: \(error)")
            }
        }
        #elseif os(iOS)
        print("Safari Extension settings are managed through iOS Settings.")
        #endif
    }

    // MARK: - UI Helper Methods

    private func createFeatureSection(systemImageName: String, title: String, description: String) -> PlatformView {
        #if os(iOS)
        let sectionStack = UIStackView()
        sectionStack.axis = .vertical
        sectionStack.alignment = .center
        sectionStack.spacing = 6

        let imageView = UIImageView(image: UIImage(systemName: systemImageName))
        imageView.tintColor = .systemBlue
        imageView.contentMode = .scaleAspectFit
        NSLayoutConstraint.activate([
            imageView.heightAnchor.constraint(equalToConstant: 30),
            imageView.widthAnchor.constraint(equalToConstant: 30)
        ])
        sectionStack.addArrangedSubview(imageView)
        #elseif os(macOS)
        let sectionStack = NSStackView()
        sectionStack.orientation = .vertical
        sectionStack.alignment = .centerX
        sectionStack.spacing = 6

        let imageView = NSImageView(image: NSImage(systemSymbolName: systemImageName, accessibilityDescription: title) ?? NSImage())
        imageView.contentTintColor = .systemBlue
        NSLayoutConstraint.activate([
            imageView.heightAnchor.constraint(equalToConstant: 30),
            imageView.widthAnchor.constraint(equalToConstant: 30)
        ])
        sectionStack.addArrangedSubview(imageView)
        #endif

        let titleLabel = createLabel(text: title, font: .boldSystemFont(ofSize: 16), color: .labelColor)
        let descLabel = createLabel(text: description, font: .systemFont(ofSize: 14), color: .secondaryLabelColor, alignment: .center)

        sectionStack.addArrangedSubview(titleLabel)
        sectionStack.addArrangedSubview(descLabel)

        return sectionStack
    }

    private func createLabel(text: String, font: PlatformFont, color: PlatformColor, alignment: NSTextAlignment = .center) -> PlatformLabel {
        #if os(iOS)
        let label = UILabel()
        label.text = text
        label.font = font
        label.textColor = color
        label.textAlignment = alignment
        label.numberOfLines = 0
        return label
        #elseif os(macOS)
        let label = NSTextField(labelWithString: text)
        label.font = font
        label.textColor = color
        label.alignment = alignment
        label.isEditable = false
        label.isSelectable = false
        return label
        #endif
    }

    // MARK: - WKNavigationDelegate & WKScriptMessageHandler

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {}

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {}
}

// MARK: - Cross-Platform Compatibility Extensions
#if os(iOS)
typealias PlatformView = UIView
typealias PlatformLabel = UILabel
extension UIColor {
    static var labelColor: UIColor { return .label }
    static var secondaryLabelColor: UIColor { return .secondaryLabel }
}
#elseif os(macOS)
typealias PlatformView = NSView
typealias PlatformLabel = NSTextField
extension NSColor {
    static var labelColor: NSColor { return .labelColor }
    static var secondaryLabelColor: NSColor { return .secondaryLabelColor }
}
#endif