//! Provider descriptors (D7, algorithm `workhub-git-providers`). This is the only file allowed
//! to name a git host product; everything else works from a [`Provider`] row.

use super::template::{self, Vars};

/// How a connection authenticates. Stored as text (`connections.auth_method`), open-ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AuthMethod {
    /// An SSH key pair Work Hub generated; the user adds the public key to the host.
    SshGenerated,
    /// An SSH private key the user uploaded (optionally with a passphrase).
    SshUploaded,
    /// A personal access token sent as HTTP Basic auth.
    Pat,
}

impl AuthMethod {
    pub const ALL: [AuthMethod; 3] = [Self::SshGenerated, Self::SshUploaded, Self::Pat];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::SshGenerated => "ssh_generated",
            Self::SshUploaded => "ssh_uploaded",
            Self::Pat => "pat",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|m| m.as_str() == raw)
    }

    /// Whether the method talks SSH (as opposed to HTTP(S)).
    pub fn is_ssh(self) -> bool {
        matches!(self, Self::SshGenerated | Self::SshUploaded)
    }
}

/// Where the SSH endpoint of a provider is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SshRule {
    /// SSH host; `None` means the host of the connection's base URL.
    pub host: Option<&'static str>,
    pub user: &'static str,
    pub port: u16,
    /// Repository path template on the SSH host.
    pub path: &'static str,
}

/// The user name of PAT Basic auth.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatUser {
    /// A fixed name the host ignores or expects.
    Fixed(&'static str),
    /// The connection's own `username` (required then).
    FromConnection,
}

/// The authenticated API call the connection Test makes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApiTest {
    /// URL template (`{web}` = base URL).
    pub url: &'static str,
    /// Header template (`{token}` = the PAT, `{basic}` = base64 of `<pat user>:<pat>`).
    pub header: &'static str,
    /// Dotted path of the user name in the JSON answer.
    pub user_field: &'static str,
}

/// One git host product (D7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Provider {
    pub id: &'static str,
    pub display_name: &'static str,
    pub short_label: &'static str,
    pub kind: &'static str,
    pub auth_methods: &'static [AuthMethod],
    pub base_template: &'static str,
    pub base_fixed: Option<&'static str>,
    pub allow_http: bool,
    /// Repository path template relative to the base URL path.
    pub https_path: &'static str,
    pub ssh: Option<SshRule>,
    /// Whether `.git` is appended to the upstream URL.
    pub git_suffix: bool,
    pub pat_user: PatUser,
    pub api_test: Option<ApiTest>,
    /// One-line greeting template with `{user}` printed by an authenticated `ssh -T`.
    pub ssh_greeting: Option<&'static str>,
    pub token_page: Option<&'static str>,
    pub token_scopes: Option<&'static str>,
    pub ssh_keys_page: Option<&'static str>,
    pub pr_url: Option<&'static str>,
    pub pr_label: Option<&'static str>,
    pub test_needs_url: bool,
    pub base_placeholder: &'static str,
    /// The hosted instance offered next to "Self-managed" when the base URL is not fixed.
    pub base_hosted: Option<&'static str>,
}

impl Provider {
    pub fn supports(&self, method: AuthMethod) -> bool {
        self.auth_methods.contains(&method)
    }

    /// Whether the connection must carry a `username` (PAT Basic auth user).
    pub fn needs_username(&self) -> bool {
        self.pat_user == PatUser::FromConnection
    }
}

const ALL_METHODS: &[AuthMethod] = &AuthMethod::ALL;

static PROVIDERS: [Provider; 4] = [
    Provider {
        id: "github",
        display_name: "GitHub",
        short_label: "GH",
        kind: "git",
        auth_methods: ALL_METHODS,
        base_template: "https://github.com",
        base_fixed: Some("https://github.com"),
        allow_http: false,
        https_path: "{owner}/{repo}",
        ssh: Some(SshRule {
            host: Some("github.com"),
            user: "git",
            port: 22,
            path: "{owner}/{repo}",
        }),
        git_suffix: true,
        pat_user: PatUser::Fixed("x-access-token"),
        api_test: Some(ApiTest {
            url: "https://api.github.com/user",
            header: "Authorization: Bearer {token}",
            user_field: "login",
        }),
        ssh_greeting: Some("Hi {user}! You've successfully authenticated"),
        token_page: Some(
            "https://github.com/settings/tokens/new?scopes=repo&description=Work%20Hub",
        ),
        token_scopes: Some("repo"),
        ssh_keys_page: Some("https://github.com/settings/ssh/new"),
        pr_url: Some("{web}/{owner}/{repo}/compare/{target}...{branch}?expand=1"),
        pr_label: Some("pull request"),
        test_needs_url: false,
        base_placeholder: "https://github.com",
        base_hosted: None,
    },
    Provider {
        id: "gitlab",
        display_name: "GitLab",
        short_label: "GL",
        kind: "git",
        auth_methods: ALL_METHODS,
        base_template: "{base}",
        base_fixed: None,
        allow_http: false,
        https_path: "{path}",
        ssh: Some(SshRule {
            host: None,
            user: "git",
            port: 22,
            path: "{path}",
        }),
        git_suffix: true,
        pat_user: PatUser::Fixed("oauth2"),
        api_test: Some(ApiTest {
            url: "{web}/api/v4/user",
            header: "PRIVATE-TOKEN: {token}",
            user_field: "username",
        }),
        ssh_greeting: Some("Welcome to GitLab, @{user}!"),
        token_page: Some(
            "{web}/-/user_settings/personal_access_tokens?name=Work%20Hub&scopes=read_repository,write_repository,read_user",
        ),
        token_scopes: Some("read_repository write_repository read_user"),
        ssh_keys_page: Some("{web}/-/user_settings/ssh_keys"),
        pr_url: Some(
            "{web}/{path}/-/merge_requests/new?merge_request%5Bsource_branch%5D={branch}&merge_request%5Btarget_branch%5D={target}",
        ),
        pr_label: Some("merge request"),
        test_needs_url: false,
        base_placeholder: "https://gitlab.example.com",
        base_hosted: Some("https://gitlab.com"),
    },
    Provider {
        id: "azure-devops",
        display_name: "Azure DevOps",
        short_label: "AZ",
        kind: "git",
        auth_methods: ALL_METHODS,
        base_template: "https://dev.azure.com/{org}",
        base_fixed: None,
        allow_http: false,
        https_path: "{project}/_git/{repo}",
        ssh: Some(SshRule {
            host: Some("ssh.dev.azure.com"),
            user: "git",
            port: 22,
            path: "v3/{org}/{project}/{repo}",
        }),
        git_suffix: false,
        pat_user: PatUser::Fixed("pat"),
        api_test: Some(ApiTest {
            url: "{web}/_apis/connectionData",
            header: "Authorization: Basic {basic}",
            user_field: "authenticatedUser.providerDisplayName",
        }),
        ssh_greeting: None,
        token_page: Some("{web}/_usersSettings/tokens"),
        token_scopes: Some("Code (Read & write)"),
        ssh_keys_page: Some("{web}/_usersSettings/keys"),
        pr_url: Some(
            "{web}/{project}/_git/{repo}/pullrequestcreate?sourceRef={branch}&targetRef={target}",
        ),
        pr_label: Some("pull request"),
        test_needs_url: false,
        base_placeholder: "https://dev.azure.com/<organization>",
        base_hosted: None,
    },
    Provider {
        id: "generic",
        display_name: "Other git server",
        short_label: "GIT",
        kind: "git",
        auth_methods: ALL_METHODS,
        base_template: "{base}",
        base_fixed: None,
        allow_http: true,
        https_path: "{path}",
        ssh: None,
        git_suffix: false,
        pat_user: PatUser::FromConnection,
        api_test: None,
        ssh_greeting: None,
        token_page: None,
        token_scopes: None,
        ssh_keys_page: None,
        pr_url: None,
        pr_label: None,
        test_needs_url: true,
        base_placeholder: "https://git.example.com",
        base_hosted: None,
    },
];

/// Every provider, in UI order.
pub fn all() -> &'static [Provider] {
    &PROVIDERS
}

/// The provider with this id.
pub fn get(id: &str) -> Option<&'static Provider> {
    PROVIDERS.iter().find(|p| p.id == id)
}

/// The user name of PAT Basic auth (`username` is the connection's own, if any).
pub fn pat_user<'a>(p: &Provider, username: Option<&'a str>) -> &'a str {
    match p.pat_user {
        PatUser::Fixed(u) => u,
        PatUser::FromConnection => username.unwrap_or(""),
    }
}

/// `base64(<pat user>:<pat>)`.
fn basic(user: &str, pat: &str) -> String {
    base64_encode(format!("{user}:{pat}").as_bytes())
}

/// The git `header` file line of a PAT connection: always `Authorization: Basic {basic}`.
pub fn git_header(p: &Provider, username: Option<&str>, pat: &str) -> String {
    format!("Authorization: Basic {}", basic(pat_user(p, username), pat))
}

/// The API request of the connection Test: `(url, header line)`, `None` without an API test.
pub fn api_request(p: &Provider, base: &str, pat: &str) -> Option<(String, String)> {
    let test = p.api_test?;
    let mut vars = Vars::new();
    vars.insert("web".into(), base.trim_end_matches('/').to_string());
    vars.insert("token".into(), pat.to_string());
    vars.insert("basic".into(), basic(pat_user(p, None), pat));
    Some((
        template::fill(test.url, &vars),
        template::fill(test.header, &vars),
    ))
}

/// A page template with `{web}` filled from the connection base URL.
pub fn page_url(tmpl: &str, base: &str) -> String {
    let mut vars = Vars::new();
    vars.insert("web".into(), base.trim_end_matches('/').to_string());
    template::fill(tmpl, &vars)
}

/// The token creation page for a base URL.
pub fn token_page_url(p: &Provider, base: &str) -> Option<String> {
    p.token_page.map(|t| page_url(t, base))
}

/// The SSH keys page for a base URL.
pub fn ssh_keys_page_url(p: &Provider, base: &str) -> Option<String> {
    p.ssh_keys_page.map(|t| page_url(t, base))
}

/// The user name in an `ssh -T` greeting, when the provider has a greeting and it matches.
pub fn greeting_user(p: &Provider, text: &str) -> Option<String> {
    template::match_line(p.ssh_greeting?, text)?.remove("user")
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard-alphabet base64 with `=` padding (RFC 4648 §4).
pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(B64[((n >> (18 - 6 * i)) & 0x3f) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}
