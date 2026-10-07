{
  description = "Save selected manaba resources into local course folders";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      eachSystem = nixpkgs.lib.genAttrs systems;
    in {
      packages = eachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          python = pkgs.python3;
        in {
          default = python.pkgs.buildPythonApplication {
            pname = "manaba-folder-sync";
            version = "0.1.0";
            pyproject = true;
            src = self;
            nativeBuildInputs = [ python.pkgs.setuptools ];
            propagatedBuildInputs = with python.pkgs; [ fastapi httpx uvicorn ];
          };
        });
      devShells = eachSystem (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [ python3 python3Packages.fastapi python3Packages.httpx python3Packages.uvicorn python3Packages.pytest libsecret ];
          };
        });
    };
}
