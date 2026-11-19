import { AZURE_START_URL } from "../../api/auth";
import { Button } from "../../ui/button";
import styles from "./login.module.css";

/** Mode `azure-oauth`: the OAuth exchange is server-side, so this is a full page navigation. */
export function AzureSignInButton() {
  return (
    <Button
      type="button"
      className={styles.fullWidth}
      onClick={() => {
        window.location.href = AZURE_START_URL;
      }}
    >
      Sign in with Microsoft
    </Button>
  );
}
