# Get data into your Azure Analysis Services cube

Data you see in **Visual Studio** (Model.bim) is the model design or a **preview** from the data source.  
The Slack bot queries the **deployed** cube on **Azure**. That deployed model must be **Processed/Refreshed** so it loads data from Azure SQL (or your source).

---

## Sync vs Process (important)

- **Synchronize model** in Azure Portal can require **Standard** pricing tier. If you see *"upgrade to Standard pricing tier"*, use **Process/Refresh** instead.
- **Process/Refresh** loads data from your data source (e.g. Azure SQL) and works on **Developer** and **Basic** tiers. No upgrade needed.

---

## Option A: Refresh from your project (recommended)

From the project folder, run:

```bash
node scripts/refresh-aas.js full
```

This sends a **Process (Refresh)** command to AAS via XMLA. Wait for it to finish (usually 1–2 minutes), then try the Slack bot again.

- `full` = full refresh (default; use after deploy or when source data changed).
- `dataOnly` = refresh data only.
- `automatic` = refresh only if needed.

**Permission:** The service principal in your `.env` (AAS_USERNAME / AAS_PASSWORD) must have **Process** permission on the database. If the script fails with an access error, in **Azure Portal** → **gnindiacube** → **Access control (IAM)** add that app as **Contributor** (or use an account that is Server Admin), then run the script again.

---

## Option B: Azure Portal (Refresh / Process)

1. Open **Azure Portal** → **Analysis Services** → **gnindiacube**.
2. Go to **Models** → **Manage** (or the model list).
3. Find your model (e.g. **MyCubeProject_HP_...**). Look for **Refresh** or **Process** (not **Sync**).
4. Run a **Full** refresh and wait for it to complete.

---

## Option C: SQL Server Management Studio (SSMS)

1. Connect to the server: `asazure://southeastasia.asazure.windows.net/gnindiacube` (use Azure AD auth).
2. Right‑click the database (e.g. **MyCubeProject_HP_...**) → **Process** → choose **Full** → OK.

---

## Fix in Visual Studio, then Rebuild & Deploy (fixes “missing Password” error)

If Process fails with *“credential is missing a required property … Property name: Password”*, the cube’s data source has no password stored. Fix it in the model, then redeploy:

1. **Visual Studio** → open your Tabular project (e.g. MyCubeProject).
2. **Tabular Model Explorer** → **Data Sources** → double‑click your SQL data source (e.g. Azure SQL).
3. Set **Server**, **Database**, **User name**, and **Password** (use the same as in your `.env`: e.g. `sqladmin` / `Azure@123456`). If there is a “Save password” or “Persist security info” option, enable it so the password is stored in the project.
4. **Build** → **Rebuild** the project.
5. **Build** → **Deploy to [your server]** (or use the Deploy button). Deploy sends the updated model and credentials to Azure.
6. After deploy, run **Process** once so the cube loads data:
   - Either run: `node scripts/refresh-aas.js full`
   - Or in **SSMS**: connect to the server → right‑click the database → **Process** → **Full** → OK.

After this, the cube should have the correct data source password and Process will work. The Slack bot can then get data from the cube (or will keep using the Azure SQL fallback if the cube is still empty until Process completes).

---

## After deploying from Visual Studio

When you **Deploy** the project, the structure is sent to Azure but **data is not** until you run a **Process/Refresh**. After every deploy (or when source data changes), run Option A or B above.

## If you still get no data

- Confirm the **data source** (e.g. Azure SQL) has rows in the **Users** table.
- In Azure Portal, check the model’s **Data Sources** and **Partitions** so the correct database and table are used.
- Ensure the Analysis Services server can reach the data source (firewall, credentials).
